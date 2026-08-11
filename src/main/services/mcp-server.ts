// ── CloakLite MCP Server ──
// Model Context Protocol server — exposed on loopback for external AI tools.
// Claude Code, Cursor, or any MCP client can connect and control browser profiles.

import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { listProfiles, getProfileInfo } from "./profile-manager.js";
import { getConfig, getProfileMeta, resolveProfileProxy, saveConfig } from "./config-manager.js";
import { getAccounts, executeToolCall, AGENT_TOOLS } from "./local-agent.js";
import { listJobs } from "./job-store.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import {
  addOrUpdateChromeStoreExtension,
  listExtensionRepository,
} from "./extension-repository.js";
import { validateDirId } from "./utils.js";
import { listCloakProfiles, launchCloak, stopCloak, statusCloak, findRuntimeChromiumBinary, getRuntimeChromiumVersion } from "./cloak-manager.js";

let server: http.Server | null = null;
let serverListening = false;
const MCP_DEFAULT_PORT = 26581;
let mcpPort = configuredMcpPort();
const MCP_TOKEN = process.env.CLOAK_MCP_TOKEN || createLocalToken();

function configuredMcpPort(): number {
  const value = Number(process.env.CLOAK_MCP_PORT ?? MCP_DEFAULT_PORT);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : MCP_DEFAULT_PORT;
}

// ═══════════════════════════════════════════════════════════════
// MCP Tool Definitions
// ═══════════════════════════════════════════════════════════════

const MCP_TOOLS = [
  {
    name: "cloak_list_profiles",
    description: "List all managed Chromium profiles",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cloak_launch_profile",
    description: "Launch a managed Chromium profile by its dirId",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID (starting with cb_)" },
      },
      required: ["dirId"],
    },
  },
  {
    name: "cloak_stop_profile",
    description: "Stop a running managed Chromium profile by its dirId",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID" },
      },
      required: ["dirId"],
    },
  },
  {
    name: "cloak_status",
    description: "Get the running status and CDP debugging details of a managed Chromium profile",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID" },
      },
      required: ["dirId"],
    },
  },
  {
    name: "cloak_list_proxies",
    description: "List all configured SOCKS5/HTTP proxies",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cloak_list_accounts",
    description: "List all stored service account usernames and target platform URLs",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cloak_profile_info",
    description: "Get detailed fingerprint metadata for a profile",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID" },
      },
      required: ["dirId"],
    },
  },
  {
    name: "cloak_list_extensions",
    description: "List all installed extensions for a profile",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID" },
      },
      required: ["dirId"],
    },
  },
  {
    name: "cloak_install_extension",
    description: "Download and extract a Chrome Web Store extension into a profile",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID" },
        extId: { type: "string", description: "32-char extension ID (e.g. cjpalhdlnbpafiamejdnhcphjbkeiagm for uBlock)" },
      },
      required: ["dirId", "extId"],
    },
  },
  {
    name: "cloak_delete_extension",
    description: "Remove an installed extension from a profile",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID" },
        extId: { type: "string", description: "Extension ID" },
      },
      required: ["dirId", "extId"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Tool Execution
// ═══════════════════════════════════════════════════════════════

// Agent tools exposed over MCP (prefixed cloak_) so external AI can drive a
// launched profile's CDP, query the agent DB, make HTTP calls, etc. Built from
// the real AGENT_TOOLS schemas so they stay in sync.
const MCP_PASSTHROUGH = [
  "browser_navigate", "browser_click", "browser_type", "browser_evaluate",
  "browser_snapshot", "browser_get_text", "browser_get_url", "browser_wait_for_load",
  "browser_screenshot", "browser_scroll", "browser_new_tab", "browser_press_key",
  "http_request", "db_query", "db_exec", "read_file", "write_file", "set_var", "get_var",
];
const MCP_PASSTHROUGH_DEFS = MCP_PASSTHROUGH.map((toolName) => {
  const t = AGENT_TOOLS.find((x) => x.function.name === toolName);
  return {
    name: `cloak_${toolName}`,
    description: t?.function.description || `Agent tool: ${toolName}`,
    inputSchema: t?.function.parameters || { type: "object", properties: {} },
  };
});
const MCP_EXPANDED_TOOLS = [...MCP_TOOLS, ...MCP_PASSTHROUGH_DEFS,
  { name: "cloak_automation_list", description: "List automation rules", inputSchema: { type: "object", properties: {} } },
  { name: "cloak_runs_list", description: "List recent agent runs", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "cloak_jobs_list", description: "List automation jobs", inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "number" } } } },
];

async function executeMcpTool(name: string, args: any): Promise<any> {
  // Passthrough to the agent tool layer (browser_*/db/http/file).
  if (name.startsWith("cloak_") && MCP_PASSTHROUGH.includes(name.slice(6))) {
    try {
      return await executeToolCall(name.slice(6), args || {});
    } catch (e: any) {
      return { error: e.message || String(e) };
    }
  }
  switch (name) {
    case "cloak_list_profiles": {
      const cloakProfiles = listCloakProfiles();
      return {
        profiles: cloakProfiles.map(p => ({
          dirId: p.dirId, name: p.name, browser: "cloak",
          running: p.running,
          proxyMode: p.proxyMode,
          proxy: p.proxyMode === "none" ? "(no proxy)" : (p.proxyName || "(missing proxy)"),
          sizeMB: "0",
        })),
        binary: { path: findRuntimeChromiumBinary(), version: getRuntimeChromiumVersion() },
      };
    }
    case "cloak_launch_profile": {
      validateDirId(args.dirId);
      try {
        const result = await launchCloak(args.dirId);
        return {
          success: true,
          pid: result.pid,
          dirId: args.dirId,
          cdpPort: result.cdpPort,
          hint: "Managed Chromium launched. Use the MCP or Agent CDP tools to automate.",
        };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }
    case "cloak_stop_profile": {
      validateDirId(args.dirId);
      const result = stopCloak(args.dirId);
      return { success: result };
    }
    case "cloak_status": {
      validateDirId(args.dirId);
      const status = statusCloak(args.dirId);
      return {
        running: status.running,
        pid: status.pid,
        cdpPort: status.cdpPort,
        dirId: args.dirId,
      };
    }
    case "cloak_list_proxies": {
      const cfg = getConfig() as any;
      const proxies = cfg.proxies || {};
      return {
        proxies: Object.entries(proxies).map(([name, p]: [string, any]) => ({
          name,
          type: p.type,
          host: p.host,
          port: p.port,
          hasAuth: Boolean(p.username),
          bypassList: Array.isArray(p.bypassList) ? p.bypassList : [],
          isDefault: cfg.defaultProxy === name,
        })),
      };
    }
    case "cloak_list_accounts": {
      return { accounts: getAccounts().map(a => ({ url: a.platformUrl, username: a.platformUserName, tags: a.tags })) };
    }
    case "cloak_profile_info": {
      validateDirId(args.dirId);
      const meta = getProfileMeta(args.dirId);
      const status = statusCloak(args.dirId);
      const resolvedProxy = resolveProfileProxy(args.dirId);
      return {
        ...meta,
        proxyMode: resolvedProxy.mode,
        proxyName: resolvedProxy.name,
        proxy: resolvedProxy.config ? {
          type: resolvedProxy.config.type,
          host: resolvedProxy.config.host,
          port: resolvedProxy.config.port,
          hasAuth: Boolean(resolvedProxy.config.username),
          bypassList: resolvedProxy.config.bypassList || [],
        } : null,
        running: status.running,
        pid: status.pid,
        dirId: args.dirId,
      };
    }
    case "cloak_list_extensions": {
      validateDirId(args.dirId);
      const cfg = getConfig() as any;
      const enabledMap = cfg.cloakProfiles?.[args.dirId]?.extensions || {};
      return {
        extensions: listExtensionRepository().map((entry) => ({
          ...entry,
          enabled: enabledMap[entry.id] === true,
        })),
        dirId: args.dirId,
      };
    }
    case "cloak_install_extension": {
      validateDirId(args.dirId);
      validateExtensionId(args.extId);
      try {
        assertCloakProfileExists(args.dirId);
        const entry = await addOrUpdateChromeStoreExtension(args.extId);
        setProfileExtensionEnabled(args.dirId, args.extId, true);
        return { success: true, extId: args.extId, dirId: args.dirId, extension: entry };
      } catch (e: any) {
        return { success: false, error: e.message || String(e) };
      }
    }
    case "cloak_delete_extension": {
      validateDirId(args.dirId);
      validateExtensionId(args.extId);
      setProfileExtensionEnabled(args.dirId, args.extId, false);
      return { success: true, extId: args.extId, dirId: args.dirId };
    }
    case "cloak_automation_list": {
      return { rules: (getConfig() as any).automation || [] };
    }
    case "cloak_runs_list": {
      return { runs: agentRunRecorder.listRuns().slice(0, Math.max(1, Math.min(args?.limit ?? 50, 200))) };
    }
    case "cloak_jobs_list": {
      return { jobs: listJobs({ status: args?.status, limit: args?.limit }) };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// HTTP SSE Server (MCP Streamable HTTP)
// ═══════════════════════════════════════════════════════════════

const sseClients = new Map<string, http.ServerResponse>();

async function buildMcpResponse(json: any): Promise<any | null> {
  const response: any = { jsonrpc: "2.0", id: json.id };

  try {
    if (json.method === "initialize") {
      response.result = {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "cloak-lite", version: "1.0.0" },
        capabilities: { tools: {} },
      };
    } else if (json.method === "tools/list") {
      response.result = { tools: MCP_EXPANDED_TOOLS };
    } else if (json.method === "tools/call") {
      const result = await executeMcpTool(json.params?.name, json.params?.arguments || {});
      const isError = Boolean(result && result.error);
      response.result = {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        ...(isError ? { isError: true } : {}),
      };
    } else if (json.method === "notifications/initialized") {
      return null;
    } else {
      response.error = { code: -32601, message: `Unknown method: ${json.method}` };
    }
  } catch (e: any) {
    response.error = { code: -32603, message: e.message || "Internal error" };
  }

  return response;
}

async function processMcpRequest(json: any, sessionId: string): Promise<void> {
  const sseRes = sseClients.get(sessionId);
  if (!sseRes) {
    console.error(`[mcp] No active SSE connection found for session ${sessionId}`);
    return;
  }

  const response = await buildMcpResponse(json);
  if (!response) return;

  try {
    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  } catch (e: any) {
    console.error(`[mcp] Failed to write message to session ${sessionId}:`, e.message);
  }
}

export function startMcpServer(): { port: number; ready: Promise<void> } {
  if (server) return { port: mcpPort, ready: serverListening ? Promise.resolve() : waitForMcpReady() };

  mcpPort = configuredMcpPort();

  let markReady: () => void;
  let markFailed: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; markFailed = reject; });

  server = http.createServer(async (req, res) => {
    if (!isTrustedOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Authorization, X-Cloak-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${mcpPort}`);
    const sessionId = url.searchParams.get("sessionId") || "default";

    if (url.pathname !== "/health" && !isAuthorized(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // MCP endpoints
    if (url.pathname === "/mcp" && req.method === "POST") {
      const body = await readBody(req);
      const json = safeJson(body);
      const sseRes = sseClients.get(sessionId);
      if (sseRes) {
        res.writeHead(202);
        res.end();
        processMcpRequest(json, sessionId).catch(e => {
          console.error("[mcp] Error processing async request:", e.message);
        });
      } else {
        const response = await buildMcpResponse(json);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response || { jsonrpc: "2.0", id: json.id, result: null }));
      }
      return;
    }

    // Health check
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "cloak-lite-mcp", port: mcpPort }));
      return;
    }

    // SSE endpoint for streaming (MCP Streamable HTTP)
    if (url.pathname === "/sse" && req.method === "GET") {
      const connId = Math.random().toString(36).substring(2, 15);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      sseClients.set(connId, res);

      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "endpoint", params: { endpoint: `/mcp?sessionId=${connId}` } })}\n\n`);

      const keepAlive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch (e) {
          clearInterval(keepAlive);
          sseClients.delete(connId);
          console.warn("[mcp] SSE keepalive failed:", e);
        }
      }, 30000);

      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(connId);
      });
      return;
    }

    // JSON-RPC without /mcp prefix
    if (req.method === "POST" && url.pathname === "/") {
      const body = await readBody(req);
      const json = safeJson(body);
      if (json.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: json.id,
          result: { protocolVersion: "2024-11-05", serverInfo: { name: "cloak-lite", version: "1.0.0" }, capabilities: { tools: {} } },
        }));
        return;
      }
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  let fallbackAttempted = false;
  const onListening = () => {
    const address = server?.address();
    if (address && typeof address !== "string") mcpPort = address.port;
    serverListening = true;
    markReady();
    console.log(`[mcp] MCP server listening on http://127.0.0.1:${mcpPort}`);
  };
  server.on("error", (err: any) => {
    serverListening = false;
    if (err.code === "EADDRINUSE" && !fallbackAttempted && mcpPort !== 0 && server) {
      fallbackAttempted = true;
      console.warn(`[mcp] Port ${mcpPort} is in use; retrying on an ephemeral loopback port.`);
      mcpPort = 0;
      server.listen(0, "127.0.0.1", onListening);
      return;
    }
    server = null;
    markFailed(err instanceof Error ? err : new Error(String(err)));
    console.error(`[mcp] Server error:`, err.message);
  });
  server.listen(mcpPort, "127.0.0.1", onListening);

  return { port: mcpPort, ready };
}

export function stopMcpServer(): Promise<void> {
  if (!server) return Promise.resolve();
  const closing = server;
  serverListening = false;
  server = null;
  for (const client of sseClients.values()) {
    try {
      client.end();
    } catch (e) {
      console.warn("[mcp] Failed to close SSE client:", e);
    }
  }
  sseClients.clear();
  return new Promise((resolve, reject) => {
    closing.close((err: NodeJS.ErrnoException | undefined) => {
      if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      console.log("[mcp] MCP server stopped");
      resolve();
    });
  });
}

export function getMcpPort(): number {
  return mcpPort;
}

export function isMcpServerRunning(): boolean {
  return serverListening;
}

async function waitForMcpReady(): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!serverListening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!serverListening) throw new Error("MCP server did not start listening in time");
}

export function getMcpToken(): string {
  return MCP_TOKEN;
}

// ── Helpers ──

function assertCloakProfileExists(dirId: string): void {
  const cfg = getConfig() as any;
  if (!cfg.cloakProfiles?.[dirId]) throw new Error("Cloak profile not found");
}

function setProfileExtensionEnabled(dirId: string, extId: string, enabled: boolean): void {
  const cfg = structuredClone(getConfig()) as any;
  const profile = cfg.cloakProfiles?.[dirId];
  if (!profile) throw new Error("Cloak profile not found");
  profile.extensions = { ...(profile.extensions || {}), [extId]: enabled };
  saveConfig(cfg);
}

function validateExtensionId(extId: string): void {
  if (!/^[a-p]{32}$/.test(extId)) {
    throw new Error(`Invalid extension ID: ${JSON.stringify(extId)}`);
  }
}

function isAuthorized(req: http.IncomingMessage, _url: URL): boolean {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
  const headerToken = req.headers["x-cloak-token"];
  const token = bearer || (Array.isArray(headerToken) ? headerToken[0] : headerToken);
  return token === MCP_TOKEN;
}

function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

function createLocalToken(): string {
  return randomBytes(32).toString("base64url");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
  });
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return {}; }
}
