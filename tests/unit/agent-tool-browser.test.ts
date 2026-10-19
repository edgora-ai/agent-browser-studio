import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

const fixture = vi.hoisted(() => ({
  dataDir: `${process.env.TMPDIR}/agent-tool-browser`, profiles: [] as any[], origins: new Set<string>(),
  forbidden: vi.fn((capability: string): never => { throw new Error(`Undeclared capability: ${capability}`); }),
}));
vi.mock("electron", () => ({ app: { getPath: () => fixture.dataDir, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => fixture.forbidden("Keychain"), encryptString: () => fixture.forbidden("Keychain"), decryptString: () => fixture.forbidden("Keychain") } }));
vi.mock("node:child_process", () => Object.fromEntries(["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"].map((name) => [name, () => fixture.forbidden(name)])));
vi.mock("../../src/main/services/browser-manager.js", () => ({ listBrowserProfiles: () => fixture.profiles,
  launchBrowser: () => fixture.forbidden("browser launch"), createBrowserProfile: () => fixture.forbidden("profile creation"),
  touchProfileActivityByPort: () => undefined, getEngineByPort: () => "chromium", getFirefoxBidiSessionByPort: () => null }));
vi.mock("../../src/main/services/profile-manager.js", () => ({ listProfiles: async () => fixture.profiles }));
vi.mock("node:dns/promises", () => ({ lookup: async (host: string) => host === "page.task49.test" ? [{ address: "198.51.100.49", family: 4 }] : fixture.forbidden(`DNS ${host}`) }));
vi.mock("node:http", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:http")>(),
  request: () => fixture.forbidden("unregistered HTTP tool request"),
}));
vi.mock("node:https", () => ({ request: () => fixture.forbidden("HTTPS") }));

import * as agent from "../../src/main/services/local-agent.js";
import { getConfig, getConfigPath, reloadConfig } from "../../src/main/services/config-manager.js";
import { agentRunRecorder } from "../../src/main/services/agent-run-trace.js";
import { cdpConnect, cdpDisconnect } from "../../src/main/services/agent/cdp-transport.js";
import { runningProcesses, type RunningEntry } from "../../src/main/services/browser/runtime-table.js";
import { captureChatBrowserScope } from "../../src/main/services/agent/run-scope.js";
import { connectBidi } from "../../src/main/services/bidi-client.js";

type Wire = { id: number; method: string; params?: any; sessionId?: string };
type CdpOptions = {
  nativeInputFailure?: boolean; nativeMismatch?: boolean; fallbackFailure?: boolean;
  element?: Partial<{ connected: boolean; visible: boolean; enabled: boolean; pointerEvents: boolean; editable: boolean }>;
  covered?: boolean; frames?: boolean; emptyTargets?: boolean; invalidMetrics?: boolean;
  navigationError?: string; lifecycleError?: string;
  onCall?: (call: Wire) => void;
  responseDelay?: (call: Wire) => number;
};
const nativeFetch = globalThis.fetch;
const closers: Array<() => Promise<void>> = [];

/** Protocol-only fixture: no browser process, page evaluation or copied tool implementation. */
async function cdpWire(options: CdpOptions = {}) {
  const calls: Wire[] = [];
  const sockets = new Set<WebSocket>();
  const delayedReplies = new Set<ReturnType<typeof setTimeout>>();
  const unexpected: string[] = [];
  let port = 0; let input = "prefill"; let pageY = 100;
  const server = http.createServer((req, res) => {
    if (req.url !== "/json") { unexpected.push(`HTTP ${req.url}`); res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(options.emptyTargets ? [] : [{ type: "page", id: "task49-root", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/task49` }]));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("message", (bytes) => {
      const call = JSON.parse(bytes.toString()) as Wire; calls.push(call); options.onCall?.(call);
      let result: any = {}; let error: string | undefined;
      const p = call.params || {};
      switch (call.method) {
        case "Page.setLifecycleEventsEnabled": if (options.lifecycleError) error = options.lifecycleError; break;
        case "Page.enable": case "Runtime.enable": case "Network.enable": case "DOM.enable": case "Input.enable": case "Emulation.enable":
        case "Runtime.releaseObject": case "DOM.scrollIntoViewIfNeeded": case "Target.detachFromTarget":
        case "Emulation.setDeviceMetricsOverride": case "Emulation.setUserAgentOverride": case "Emulation.setGeolocationOverride": case "Page.close": break;
        case "Target.getTargetInfo": result = { targetInfo: { targetId: "task49-root" } }; break;
        case "Target.getTargets": result = { targetInfos: options.frames ? [
          { targetId: "child", type: "iframe", parentId: "task49-root" },
          { targetId: "grandchild", type: "iframe", parentFrameId: "child" },
          { targetId: "orphan", type: "iframe", parentId: "not-owned" },
          { targetId: "cycle", type: "iframe", parentId: "cycle" },
          { targetId: "other-page", type: "page" },
        ] : [] }; break;
        case "Target.attachToTarget": result = { sessionId: `session-${p.targetId}` }; break;
        case "Page.getFrameTree": result = { frameTree: { frame: { id: "task49-root", loaderId: "task49-loader" } } }; break;
        case "Page.createIsolatedWorld": result = { executionContextId: call.sessionId ? 4902 : 4901 }; break;
        case "Runtime.evaluate": {
          const expression = String(p.expression);
          if (p.returnByValue === false) {
            if (expression.includes('"#broken"')) result = { exceptionDetails: { exception: { description: "synthetic selector exception" } } };
            else if (expression.includes('"#missing"') || expression.includes('"#frame"') && call.sessionId !== "session-grandchild") result = { result: { subtype: "null", value: null } };
            else result = { result: { objectId: "task49-input" } };
          } else {
            let value: any = "task49 snapshot";
            if (expression === "1") value = 1;
            else if (expression.includes("throw new Error")) { result = { exceptionDetails: { text: "synthetic page exception" } }; break; }
            else if (expression === "location.href" || expression === "window.location.href") value = "https://page.task49.test/current";
            else if (expression === "document.title") value = "Task 49 title";
            else if (expression === "document.readyState") value = "loading";
            else if (expression.includes("textContent?.trim")) value = "Task 49 text";
            else if (expression.startsWith("!!document.querySelector")) value = !expression.includes("#missing");
            else if (expression.includes("getAttribute")) value = "task49-attribute";
            else if (expression === "({error: 'business', ok: false})") value = { error: "business", ok: false };
            result = { result: { value } };
          }
          break;
        }
        case "Runtime.callFunctionOn": {
          const source = String(p.functionDeclaration);
          let value: any;
          if (source.includes("const rect = this.getBoundingClientRect()")) value = { connected: true, visible: true, enabled: true, pointerEvents: true, editable: true, tagName: "INPUT", frameDepth: 0, rect: { x: 10, y: 20, width: 100, height: 30 }, ...options.element };
          else if (source.includes("elementFromPoint")) value = { hit: !options.covered, covering: options.covered ? "div.overlay" : null };
          else if (source.includes("this.dispatchEvent")) { value = !options.fallbackFailure; if (value) input = p.arguments[0].value; }
          else if (source.includes("String(this.value")) value = input;
          else if (source.includes("this.focus()")) value = true;
          else { unexpected.push("unregistered callFunctionOn"); error = "unregistered function"; break; }
          result = { result: { value } }; break;
        }
        case "Input.dispatchKeyEvent":
          if (options.nativeInputFailure) { error = "synthetic Input domain unavailable"; break; }
          if (!options.nativeMismatch) {
            if (p.key === "Backspace" && p.type === "rawKeyDown") input = "";
            else if (p.type === "char") input += p.text || "";
          }
          break;
        case "Input.insertText": if (!options.nativeMismatch) input += p.text; break;
        case "Input.dispatchMouseEvent": if (p.type === "mouseWheel") pageY += p.deltaY; break;
        case "Page.getLayoutMetrics": result = options.invalidMetrics ? {} : { cssLayoutViewport: { pageY, clientWidth: 1280, clientHeight: 720 }, cssContentSize: { height: 5000 } }; break;
        case "DOM.getFrameOwner": result = { backendNodeId: 49 }; break;
        case "DOM.getBoxModel": result = { model: { content: [100, 100, 1380, 100, 1380, 820, 100, 820] } }; break;
        case "Page.navigate": result = { frameId: "task49-root", loaderId: "task49-loader", ...(options.navigationError ? { errorText: options.navigationError } : {}) }; break;
        case "Page.captureScreenshot": result = { data: "c3ludGhldGljLXRhc2s0OS1waXhlbHM=" }; break;
        case "Network.getAllCookies": result = { cookies: [{ name: "session", domain: "page.task49.test", value: "synthetic-secret-cookie" }] }; break;
        case "Network.setCookie": result = { success: true }; break;
        case "Target.createTarget": result = { targetId: "task49-tab" }; break;
        case "DOM.getDocument": result = { root: { nodeId: 1 } }; break;
        case "DOM.querySelector": result = { nodeId: p.selector === "#missing" ? 0 : 49 }; break;
        case "DOM.setFileInputFiles": break;
        default: unexpected.push(call.method); error = `unregistered protocol method ${call.method}`;
      }
      const reply = () => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: call.id, ...(error ? { error: { message: error } } : { result }) })); };
      const delay = options.responseDelay?.(call) ?? 0;
      if (delay) {
        const timer = setTimeout(() => { delayedReplies.delete(timer); reply(); }, delay);
        delayedReplies.add(timer);
      } else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  fixture.origins.add(`http://127.0.0.1:${port}`);
  fixture.profiles.push({ dirId: `ab_${port}`, name: "Task49", running: true, cdpPort: port, fingerprintSeed: 49 });
  closers.push(async () => {
    for (const timer of delayedReplies) clearTimeout(timer);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(unexpected).toEqual([]);
  });
  return { port, calls, sockets, options, get input() { return input; }, broadcast(method: string, params: any) { for (const socket of sockets) socket.send(JSON.stringify({ method, params })); } };
}

async function bidiWire(options: { insertFailure?: boolean; filesFailure?: boolean; loading?: boolean } = {}) {
  const calls: Wire[] = []; const sockets = new Set<WebSocket>(); const unexpected: string[] = [];
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server });
  const remote = (value: any): any => value === null ? { type: "null" } : typeof value === "object"
    ? { type: "object", value: Object.entries(value).map(([key, item]) => [key, remote(item)]) }
    : { type: typeof value, value };
  wss.on("connection", (socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("message", (bytes) => {
      const call = JSON.parse(bytes.toString()) as Wire; calls.push(call); let result: any = {}; let error: string | undefined;
      const p = call.params || {};
      switch (call.method) {
        case "session.new": result = { sessionId: "task49-bidi", capabilities: {} }; break;
        case "browsingContext.getTree": result = { contexts: [{ context: "task49-context", url: "about:blank" }] }; break;
        case "browsingContext.navigate": result = { navigation: "task49-navigation", url: p.url }; break;
        case "browsingContext.create": result = { context: "task49-new-tab" }; break;
        case "browsingContext.captureScreenshot": result = { data: "c3ludGhldGljLXRhc2s0OQ==" }; break;
        case "storage.getCookies": result = { cookies: [{ name: "session", domain: "page.task49.test", value: { type: "string", value: "synthetic-cookie" } }] }; break;
        case "input.performActions": break;
        case "input.insertText": result = { success: !options.insertFailure }; break;
        case "input.setFiles": result = { success: !options.filesFailure }; break;
        case "script.evaluate": {
          const expression = String(p.expression); let value: any;
          if (p.resultOwnership === "root") { result = { result: expression.includes("#missing") ? { type: "null" } : { type: "node", sharedId: "task49-file-node" } }; break; }
          if (expression.includes("throw new Error")) { result = { result: { type: "exception", exceptionDetails: { text: "synthetic BiDi exception" } } }; break; }
          if (expression === "location.href") value = "https://page.task49.test/firefox";
          else if (expression === "document.title") value = "Task49 Firefox";
          else if (expression === "document.readyState") value = options.loading ? "loading" : "complete";
          else if (expression === "({error: 'business', ok: false})") value = { error: "business", ok: false };
          else if (expression.startsWith("!!document.querySelector")) value = !expression.includes("#missing");
          else if (expression.includes("getBoundingClientRect")) value = expression.includes("#missing") ? null : { x: 49, y: 50 };
          else if (expression.includes("const editable")) value = !expression.includes("#readonly");
          else if (expression.includes("TreeWalker") || expression.includes("querySelectorAll")) value = "Task49 Firefox snapshot";
          else if (expression.includes("textContent || ''")) value = "Task49 Firefox text";
          else if (expression.includes("scrollBy") || expression.includes("dispatchEvent(new Event('change'")) value = true;
          else { unexpected.push(expression.slice(0, 120)); error = "unregistered script expression"; break; }
          result = { result: remote(value) }; break;
        }
        default: unexpected.push(call.method); error = `unregistered method ${call.method}`;
      }
      socket.send(JSON.stringify({ id: call.id, ...(error ? { type: "error", error: "unknown command", message: error } : { type: "success", result }) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port; const connection = await connectBidi(`ws://127.0.0.1:${port}/session`);
  closers.push(async () => { connection.close(); for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); expect(unexpected).toEqual([]); });
  const context: agent.AgentToolExecutionContext = { engineResolver: () => "firefox", sessionResolver: () => connection };
  return { port, calls, connection, context };
}

beforeEach(() => {
  fixture.profiles.length = 0; fixture.forbidden.mockClear(); runningProcesses.clear();
  fs.rmSync(fixture.dataDir, { recursive: true, force: true }); reloadConfig(); getConfig();
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!fixture.origins.has(url.origin)) return fixture.forbidden(`fetch ${url.origin}`);
    return nativeFetch(input, init);
  });
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  fixture.origins.clear(); runningProcesses.clear(); vi.unstubAllGlobals();
  expect(fixture.forbidden).not.toHaveBeenCalled();
});

describe("real Chromium tool dispatch over fake CDP wire", () => {
  it("rejects native navigation failure and translates only a typed load timeout in the public tool", async () => {
    const broken = await cdpWire({ navigationError: "net::ERR_PROXY_CONNECTION_FAILED" });
    await expect(agent.executeToolCall("browser_navigate", { port: broken.port, url: "https://page.task49.test/failure" })).rejects.toMatchObject({ code: "BROWSER_NAVIGATION_FAILED" });
    const quiet = await cdpWire();
    expect(await agent.executeToolCall("browser_wait_for_load", { port: quiet.port, timeout: 100 })).toEqual({ loaded: false });
    const refused = await cdpWire({ lifecycleError: "synthetic load protocol refusal" });
    await expect(agent.executeToolCall("browser_wait_for_load", { port: refused.port, timeout: 100 })).rejects.toThrow("synthetic load protocol refusal");
  });

  it("honors an explicit unscoped caller cancellation during navigation and load preparation", async () => {
    const navController = new AbortController();
    const navigation = await cdpWire({ onCall: (call) => { if (call.method === "Page.navigate") navController.abort(new Error("unscoped navigation cancelled")); } });
    await expect(agent.executeToolCall("browser_navigate", { port: navigation.port, url: "https://page.task49.test/cancel" }, undefined, { signal: navController.signal })).rejects.toThrow("unscoped navigation cancelled");
    const loadController = new AbortController();
    const load = await cdpWire({ onCall: (call) => { if (call.method === "Page.createIsolatedWorld") loadController.abort(new Error("unscoped load cancelled")); } });
    await expect(agent.executeToolCall("browser_wait_for_load", { port: load.port, timeout: 100 }, undefined, { signal: loadController.signal })).rejects.toThrow("unscoped load cancelled");
  });

  it("includes a held cached-client probe in the public load timeout without evicting the shared client", async () => {
    const wire = await cdpWire();
    await agent.executeToolCall("browser_get_title", { port: wire.port });
    wire.options.responseDelay = (call) => call.method === "Runtime.evaluate" && call.params?.expression === "1" ? 180 : 0;
    const start = Date.now();
    expect(await agent.executeToolCall("browser_wait_for_load", { port: wire.port, timeout: 100 })).toEqual({ loaded: false });
    expect(Date.now() - start).toBeLessThan(160);
    expect(wire.calls.some((call) => call.method === "Page.getFrameTree")).toBe(false);
    wire.options.responseDelay = undefined;
    expect(await agent.executeToolCall("browser_get_title", { port: wire.port })).toEqual({ title: "Task 49 title" });
    expect(wire.calls.filter((call) => call.method === "Page.enable")).toHaveLength(1);
  });

  it("records actual navigation/timeout wire outcomes as failed Agent steps and persists their readback", async () => {
    const broken = await cdpWire({ navigationError: "net::ERR_PROXY_CONNECTION_FAILED" });
    const quiet = await cdpWire();
    let round = 0;
    const model = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume only the owned synthetic request */ }
      const message = round++ === 0 ? { role: "assistant", content: "", tool_calls: [
        { id: "native-failure", type: "function", function: { name: "browser_navigate", arguments: JSON.stringify({ port: broken.port, url: "https://page.task49.test/failure" }) } },
        { id: "load-expiry", type: "function", function: { name: "browser_wait_for_load", arguments: JSON.stringify({ port: quiet.port, timeout: 100 }) } },
      ] } : { role: "assistant", content: "Neither navigation nor full load was verified." };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message }] }));
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    fixture.origins.add(origin);
    closers.push(async () => { model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); });
    const run = agentRunRecorder.startRun({ name: "Synthetic navigation failure", source: { type: "chat", conversationId: "navigation-wire-fixture" } });
    await agent.agentChat({ provider: "openai", model: "synthetic-local-wire", apiUrl: origin + "/v1", apiKey: "synthetic-fixture-only" }, [{ role: "user", content: "Exercise only the local wire fixture" }], { runId: run.id });
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).agentRuns.find((item: any) => item.id === run.id);
    expect(stored.steps).toMatchObject([
      { tool: "browser_navigate", ok: false, error: expect.stringContaining("ERR_PROXY_CONNECTION_FAILED") },
      { tool: "browser_wait_for_load", ok: false, result: { loaded: false } },
    ]);
    agentRunRecorder.finishRun(run.id, "done", undefined, { endReason: "completed", verification: { status: "unverified" } });
    reloadConfig();
    expect(agentRunRecorder.listRuns().find((item) => item.id === run.id)?.steps).toMatchObject([{ ok: false }, { ok: false }]);
  });

  it("retains MCP isError for the actual native navigation failure and loaded:false tool outcomes", async () => {
    vi.stubEnv("AGENT_BROWSER_MCP_PORT", "0");
    const mcp = await import("../../src/main/services/mcp-server.js");
    const started = mcp.startMcpServer(); await started.ready;
    const origin = `http://127.0.0.1:${mcp.getMcpPort()}`;
    fixture.origins.add(origin);
    const broken = await cdpWire({ navigationError: "net::ERR_PROXY_CONNECTION_FAILED" });
    const quiet = await cdpWire();
    try {
      for (const [name, args] of [
        ["agent_browser_navigate", { port: broken.port, url: "https://page.task49.test/mcp-failure" }],
        ["agent_browser_wait_for_load", { port: quiet.port, timeout: 100 }],
      ] as const) {
        const response = await fetch(origin + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${mcp.getMcpToken()}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(1500) });
        expect(response.status).toBe(200);
        const body: any = await response.json();
        expect(body.result.isError).toBe(true);
        const payload = JSON.parse(body.result.content[0].text);
        if (name === "agent_browser_navigate") expect(payload.error).toContain("ERR_PROXY_CONNECTION_FAILED");
        else expect(payload).toEqual({ loaded: false });
      }
    } finally { await mcp.stopMcpServer(); vi.unstubAllEnvs(); }
  });

  it("dispatches navigation, extraction, screenshots, cookies and tabs without launching a browser", async () => {
    const wire = await cdpWire(); const args = { port: wire.port };
    expect(await agent.executeToolCall("browser_navigate", { ...args, url: "https://page.task49.test/new" })).toMatchObject({ frameId: "task49-root" });
    expect(await agent.executeToolCall("browser_get_url", args)).toEqual({ url: "https://page.task49.test/current" });
    expect(await agent.executeToolCall("browser_get_title", args)).toEqual({ title: "Task 49 title" });
    expect(await agent.executeToolCall("browser_get_text", { ...args, selector: "#result" })).toEqual({ text: "Task 49 text" });
    expect(await agent.executeToolCall("browser_evaluate", { ...args, expression: "({error: 'business', ok: false})" })).toEqual({ value: { error: "business", ok: false } });
    expect(await agent.executeToolCall("browser_snapshot", args)).toBe("task49 snapshot");
    const screenshot = await agent.executeToolCall("browser_screenshot", args);
    expect(screenshot).toMatchObject({ base64: expect.stringContaining("c3ludGhldGlj"), note: "Screenshot captured successfully" });
    expect(await agent.executeToolCall("browser_get_cookies", args)).toEqual({ cookies: [{ name: "session", domain: "page.task49.test" }] });
    expect(await agent.executeToolCall("browser_new_tab", args)).toEqual({ targetId: "task49-tab", url: "about:blank" });
    expect(await agent.executeToolCall("browser_new_tab", { ...args, url: "https://page.task49.test/tab" })).toEqual({ targetId: "task49-tab", url: "https://page.task49.test/tab" });
    expect(wire.calls.some((call) => call.method === "Page.captureScreenshot" && call.params.format === "png")).toBe(true);
    expect(wire.calls.filter((call) => call.method === "Page.enable")).toHaveLength(1);
    await expect(agent.executeToolCall("browser_evaluate", { ...args, expression: "throw new Error('synthetic')" })).rejects.toThrow("synthetic page exception");
  });

  it("verifies native clicks/hover and ASCII/unicode typing with real dispatched input sequence", async () => {
    const wire = await cdpWire(); const args = { port: wire.port, selector: "#input" };
    expect(await agent.executeToolCall("browser_click", args)).toMatchObject({ success: true, native: true, frameDepth: 0 });
    expect(await agent.executeToolCall("browser_hover", args)).toMatchObject({ success: true, native: true });
    expect(await agent.executeToolCall("browser_type", { ...args, text: "A9 中" })).toMatchObject({ success: true, native: true, fallback: false, length: 4 });
    expect(wire.input).toBe("A9 中");
    expect(wire.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")).toHaveLength(1);
    expect(wire.calls.some((call) => call.method === "Input.insertText" && call.params.text === "中")).toBe(true);
    expect(wire.calls.filter((call) => call.method === "Runtime.releaseObject")).toHaveLength(3);
  });

  it("maps a nested iframe interaction through CDP scopes and detaches owned sessions", async () => {
    const wire = await cdpWire({ frames: true });
    const result = await agent.executeToolCall("browser_click", { port: wire.port, selector: "#frame" });
    expect(result).toMatchObject({ success: true, frameDepth: 2 });
    expect(result.x).toBeGreaterThan(200);
    expect(wire.calls.filter((call) => call.method === "Target.attachToTarget").map((call) => call.params.targetId)).toEqual(["child", "grandchild"]);
    expect(wire.calls.find((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")?.sessionId).toBe("session-grandchild");
    expect(wire.calls.filter((call) => call.method === "Target.detachFromTarget").map((call) => call.params.sessionId)).toEqual(["session-grandchild", "session-child"]);
  });

  it.each([false, true])("reports native typing fallback honestly (wire failure %s)", async (nativeInputFailure) => {
    const wire = await cdpWire({ nativeInputFailure, nativeMismatch: !nativeInputFailure });
    const result = await agent.executeToolCall("browser_type", { port: wire.port, selector: "#input", text: "synthetic-fallback" });
    expect(result).toMatchObject({ success: true, native: false, fallback: true, nativeError: expect.any(String) }); expect(wire.input).toBe("synthetic-fallback");
  });

  it("does not report successful input when both native and fallback fail", async () => {
    const wire = await cdpWire({ nativeInputFailure: true, fallbackFailure: true });
    await expect(agent.executeToolCall("browser_type", { port: wire.port, selector: "#input", text: "never-entered" })).rejects.toThrow("Input domain unavailable");
    expect(wire.input).toBe("prefill");
  });

  it.each([
    [{ visible: false }, "not visible"], [{ enabled: false }, "disabled"], [{ pointerEvents: false }, "pointer events"],
    [{ connected: false }, "detached"], [{ editable: false }, "not editable"],
  ])("rejects non-actionable state %j instead of reporting success", async (element, message) => {
    const wire = await cdpWire({ element });
    await expect(agent.executeToolCall("browser_type", { port: wire.port, selector: "#input", text: "not-entered" })).rejects.toThrow(message);
    expect(wire.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toEqual([]);
  });

  it("rejects absent/covered elements and surfaces selector exceptions", async () => {
    const wire = await cdpWire({ covered: true });
    await expect(agent.executeToolCall("browser_click", { port: wire.port, selector: "#missing" })).rejects.toThrow("not found");
    await expect(agent.executeToolCall("browser_hover", { port: wire.port, selector: "#broken" })).rejects.toThrow("selector exception");
    await expect(agent.executeToolCall("browser_click", { port: wire.port, selector: "#input" })).rejects.toThrow("div.overlay");
    expect(wire.calls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")).toBe(false);
  });

  it("presses keys, scrolls both directions, selects and uploads only a synthetic owned file", async () => {
    const wire = await cdpWire(); const port = wire.port;
    for (const key of ["Enter", "Space", "a", "ArrowDown", "UnknownKey"]) expect(await agent.executeToolCall("browser_press_key", { port, key, delayMs: 0 })).toMatchObject({ success: true, native: true });
    expect(await agent.executeToolCall("browser_scroll", { port, direction: "down", amount: 120 })).toMatchObject({ success: true, settled: true, amount: 120 });
    expect(await agent.executeToolCall("browser_scroll", { port, direction: "up", amount: 120 })).toMatchObject({ success: true, settled: true });
    expect(await agent.executeToolCall("browser_select", { port, selector: "select", value: "49" })).toMatchObject({ success: true, value: "49" });
    fs.mkdirSync(fixture.dataDir, { recursive: true }); const upload = path.join(fixture.dataDir, "synthetic-upload.txt"); fs.writeFileSync(upload, "task49 fixture");
    expect(fs.readFileSync(upload, "utf8")).toBe("task49 fixture");
    reloadConfig(); expect(fs.readFileSync(upload, "utf8").includes("task49")).toBe(true);
    expect(await agent.executeToolCall("browser_upload_file", { port, selector: "#file", filePath: upload })).toMatchObject({ success: true, filePath: upload });
    await expect(agent.executeToolCall("browser_upload_file", { port, selector: "#missing", filePath: upload })).rejects.toThrow("File input not found");
    expect(await agent.executeToolCall("browser_wait_for", { port, selector: "#input", timeout: 100 })).toMatchObject({ found: true });
    expect(await agent.executeToolCall("browser_wait_for", { port, selector: "#missing", timeout: 100 })).toMatchObject({ found: false });
    expect(await agent.executeToolCall("browser_wait_for_load", { port, timeout: 100 })).toEqual({ loaded: false });
  });

  it("uses the key fallback only after protocol failure and handles unavailable scroll metrics", async () => {
    const wire = await cdpWire({ nativeInputFailure: true, invalidMetrics: true });
    expect(await agent.executeToolCall("browser_press_key", { port: wire.port, key: "Tab", delayMs: 0 })).toMatchObject({ success: true, native: false });
    expect(wire.calls.some((call) => call.method === "Runtime.evaluate" && call.params.expression.includes("KeyboardEvent"))).toBe(true);
    expect(await agent.executeToolCall("browser_scroll", { port: wire.port, direction: "down", amount: 100 })).toMatchObject({ settled: false });
    const client = await cdpConnect(wire.port); await expect(agent.cdpScroll(client, "sideways" as any)).rejects.toThrow("Invalid scroll direction"); cdpDisconnect(client);
  });

  it("covers exported CDP helpers using the same wire, with observation listener cleanup", async () => {
    const wire = await cdpWire(); const client = await cdpConnect(wire.port, 49); client.targetId = null;
    expect(await agent.cdpGetAttribute(client, "#input", "name")).toBe("task49-attribute");
    expect(await agent.cdpExists(client, "#input")).toBe(true);
    expect(await agent.cdpHover(client, "#input")).toMatchObject({ success: true });
    await agent.cdpSetViewport(client, 1200, 800); await agent.cdpSetUserAgent(client, "task49"); await agent.cdpSetGeolocation(client, 1, 2);
    await agent.cdpSetCookie(client, { name: "task49", value: "synthetic", domain: ".page.task49.test", secure: true });
    await agent.cdpSetCookie(client, { name: "task49", value: "synthetic", url: "https://page.task49.test", secure: false });
    const baseline = client.ws.listenerCount("message");
    const requests = agent.cdpGetRequests(client); const logs = agent.cdpConsoleMessages(client);
    wire.broadcast("Network.requestWillBeSent", { request: { url: "https://page.task49.test/data" } });
    wire.broadcast("Runtime.consoleAPICalled", { args: [{ value: "task49" }, { description: "description" }] });
    expect(await requests).toEqual([{ url: "https://page.task49.test/data" }]); expect(await logs).toEqual(["task49 description"]);
    expect(client.ws.listenerCount("message")).toBe(baseline);
    await agent.cdpCloseTab(client); cdpDisconnect(client);
  });

  it("cancels a scoped input between wire dispatches and leaves a fresh retry usable", async () => {
    const wire = await cdpWire(); const dirId = "ab_task49_cancel";
    const entry = { pid: process.pid, port: wire.port } as RunningEntry; runningProcesses.set(dirId, entry);
    const scope = captureChatBrowserScope(dirId)!; const controller = new AbortController();
    wire.options.onCall = (call) => { if (call.method === "Input.dispatchKeyEvent" && call.params.type === "rawKeyDown") controller.abort(new Error("task49 scoped cancel")); };
    await expect(agent.executeToolCall("browser_press_key", { port: wire.port, key: "Enter", delayMs: 0 }, undefined, { browserScope: scope, signal: controller.signal })).rejects.toThrow("task49 scoped cancel");
    expect(wire.calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params.type)).toEqual(["rawKeyDown"]);
    wire.options.onCall = undefined;
    expect(await agent.executeToolCall("browser_get_title", { port: wire.port }, undefined, { browserScope: scope })).toEqual({ title: "Task 49 title" });
    const before = wire.calls.length;
    runningProcesses.set(dirId, { ...entry });
    await expect(agent.executeToolCall("browser_get_title", { port: wire.port }, undefined, { browserScope: scope })).rejects.toThrow("replaced");
    expect(wire.calls).toHaveLength(before);
  });

  it("rejects invalid arguments or no selected environment before browser wire writes", async () => {
    for (const args of [{ port: "NaN" }, { port: -1 }, { port: 65536 }]) await expect(agent.executeToolCall("browser_get_title", args)).rejects.toThrow("Invalid CDP port");
    await expect(agent.executeToolCall("browser_get_title", { port: 1 })).rejects.toThrow("not a valid debug port");
    await expect(agent.executeToolCall("browser_get_title", { port: 49000 }, undefined, { browserScope: null })).rejects.toThrow();
    await expect(agent.executeToolCall("browser_click", { port: 49000, selector: "" })).rejects.toThrow("Invalid selector");
    expect(await agent.executeToolCall("unknown-task49", {})).toEqual({ error: "Unknown tool: unknown-task49" });
  });
});

describe("real Firefox tool dispatch over fake BiDi wire", () => {
  it("uses the managed BiDi wire for every read/navigation tool instead of opening Chromium", async () => {
    const wire = await bidiWire(); const call = (name: string, args: any = {}) => agent.executeToolCall(name, { port: wire.port, ...args }, undefined, wire.context);
    expect(await call("browser_navigate", { url: "https://page.task49.test/firefox" })).toEqual({ url: "https://page.task49.test/firefox" });
    expect(await call("browser_get_url")).toEqual({ url: "https://page.task49.test/firefox" });
    expect(await call("browser_get_title")).toEqual({ title: "Task49 Firefox" });
    expect(await call("browser_get_text", { selector: "#data" })).toEqual({ text: "Task49 Firefox text" });
    expect(await call("browser_evaluate", { expression: "({error: 'business', ok: false})" })).toEqual({ value: { error: "business", ok: false } });
    expect(await call("browser_snapshot")).toBe("Task49 Firefox snapshot");
    expect(await call("browser_screenshot")).toMatchObject({ base64: expect.stringContaining("c3ludGhldGlj") });
    expect(await call("browser_get_cookies")).toEqual({ cookies: [{ name: "session", domain: "page.task49.test" }] });
    expect(await call("browser_new_tab", { url: "https://page.task49.test/tab" })).toEqual({ targetId: "task49-new-tab", url: "https://page.task49.test/tab" });
    expect(await call("browser_wait_for", { selector: "#data", timeout: 100 })).toEqual({ found: true, selector: "#data" });
    expect(await call("browser_wait_for_load", { timeout: 100 })).toEqual({ loaded: true });
    await expect(call("browser_evaluate", { expression: "throw new Error('fixture')" })).rejects.toThrow("synthetic BiDi exception");
    expect(wire.calls.some((entry) => entry.method === "browsingContext.navigate" && entry.params.wait === "interactive")).toBe(true);
  });

  it("executes native input and file upload, and surfaces non-throwing BiDi failures", async () => {
    const wire = await bidiWire({ insertFailure: true, filesFailure: true });
    const call = (name: string, args: any = {}) => agent.executeToolCall(name, { port: wire.port, ...args }, undefined, wire.context);
    expect(await call("browser_click", { selector: "#input" })).toMatchObject({ success: true, native: true, x: 49 });
    expect(await call("browser_hover", { selector: "#input" })).toMatchObject({ success: true, native: true });
    expect(await call("browser_type", { selector: "#input", text: "not inserted" })).toMatchObject({ success: false });
    expect(await call("browser_press_key", { key: "Enter", delayMs: 49 })).toMatchObject({ success: true, native: true });
    expect(await call("browser_scroll", { direction: "up", amount: 49 })).toMatchObject({ success: true, direction: "up" });
    expect(await call("browser_select", { selector: "select", value: "49" })).toMatchObject({ success: true });
    fs.mkdirSync(fixture.dataDir, { recursive: true }); const filePath = path.join(fixture.dataDir, "firefox-upload.txt"); fs.writeFileSync(filePath, "task49 synthetic");
    expect(fs.readFileSync(filePath, "utf8")).toBe("task49 synthetic"); reloadConfig(); expect(fs.readFileSync(filePath, "utf8")).toContain("task49");
    expect(await call("browser_upload_file", { selector: "#file", filePath })).toMatchObject({ success: false });
    await expect(call("browser_click", { selector: "#missing" })).rejects.toThrow("not found");
    await expect(call("browser_type", { selector: "#readonly", text: "no" })).rejects.toThrow("not editable");
    await expect(call("browser_press_key", { key: "UnsupportedKey" })).rejects.toThrow("Unsupported key");
    await expect(call("browser_upload_file", { selector: "#missing", filePath })).rejects.toThrow("not found");
    expect(wire.calls.find((entry) => entry.method === "input.setFiles")?.params.element).toEqual({ sharedId: "task49-file-node" });
  });

  it("keeps failed waits explicit and rejects an absent or cross-instance managed session", async () => {
    const wire = await bidiWire({ loading: true });
    expect(await agent.executeToolCall("browser_wait_for", { port: wire.port, selector: "#missing", timeout: 100 }, undefined, wire.context)).toEqual({ found: false, selector: "#missing" });
    expect(await agent.executeToolCall("browser_wait_for_load", { port: wire.port, timeout: 100 }, undefined, wire.context)).toEqual({ loaded: false });
    await expect(agent.executeToolCall("browser_get_title", { port: wire.port }, undefined, { engineResolver: () => "firefox" })).rejects.toThrow("no live managed session");
    const dirId = "ab_task49_firefox"; runningProcesses.set(dirId, { pid: process.pid, port: wire.port, bidiConn: wire.connection } as RunningEntry);
    const scope = captureChatBrowserScope(dirId)!;
    expect(await agent.executeToolCall("browser_get_title", { port: wire.port }, undefined, { ...wire.context, browserScope: scope })).toEqual({ title: "Task49 Firefox" });
    const other = await bidiWire(); const before = other.calls.length;
    await expect(agent.executeToolCall("browser_get_title", { port: wire.port }, undefined, { engineResolver: () => "firefox", sessionResolver: () => other.connection, browserScope: scope })).rejects.toThrow("does not belong");
    expect(other.calls).toHaveLength(before);
  });
});
