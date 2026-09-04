// ── Agent Browser Studio MCP Server ──
// Model Context Protocol server — exposed on loopback for external AI tools.
// Claude Code, Cursor, or any MCP client can connect and control browser profiles.

import * as http from "node:http";
import { readBody as httpReadBody } from "./http/body.js";
import { isAuthorized as isAuthorizedShared } from "./http/auth.js";
import { randomBytes } from "node:crypto";
import { listProfiles, getProfileInfo } from "./profile-manager.js";
import { getConfig, getProfileMeta, resolveProfileProxy, saveConfig } from "./config-manager.js";
import { getAccounts, executeToolCall, AGENT_TOOLS, agentChat, llmChat, getLlmConfig, getOrDetectLlmConfig, redactLlmConfig, createConversation, getConversation, listConversations, deleteConversation, renameConversation, addMessage, repairMessageSequence, type LlmMessage } from "./local-agent.js";
import { listJobs } from "./job-store.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import {
  addOrUpdateChromeStoreExtension,
  listExtensionRepository,
} from "./extension-repository.js";
import { validateDirId } from "./utils.js";
import { listBrowserProfiles, launchBrowser, stopBrowser, statusBrowser, findRuntimeChromiumBinary, getRuntimeChromiumVersion, getEngineStatus } from "./browser-manager.js";
import { listSkillRepository, getSkill, installSkill } from "./skill-repository.js";
import { listPlatformAdapters, getPlatformAdapter, detectAdapter } from "./platform-adapters.js";
import { listPendingApprovals, resolveApproval } from "./approval-gate.js";
import { requireSettingsMutation } from "./team.js";
import { agentDbTables } from "./agent-db.js";

/** Team RBAC for mutation-class MCP tools (R2 #50): mirrors the REST gates.
 * Returns an error string when denied, null when allowed. */
function denyMcpMutation(): string | null {
  try {
    const r = requireSettingsMutation();
    return r.ok ? null : (r.error || "Permission denied");
  } catch (e: any) {
    return e?.message || String(e);
  }
}

let server: http.Server | null = null;
let serverListening = false;
const MCP_DEFAULT_PORT = 26581;
let mcpPort = configuredMcpPort();
const MCP_TOKEN = process.env.AGENT_BROWSER_MCP_TOKEN
  || process.env.CLOAK_MCP_TOKEN // pre-rename compatibility
  || createLocalToken();

function configuredMcpPort(): number {
  const value = Number(process.env.AGENT_BROWSER_MCP_PORT ?? process.env.CLOAK_MCP_PORT ?? MCP_DEFAULT_PORT);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : MCP_DEFAULT_PORT;
}

// ═══════════════════════════════════════════════════════════════
// MCP Tool Definitions
// ═══════════════════════════════════════════════════════════════

const MCP_TOOLS = [
  {
    name: "agent_browser_list_profiles",
    description: "List all managed Chromium profiles",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_browser_launch_profile",
    description: "Launch a managed Chromium profile by its dirId",
    inputSchema: {
      type: "object",
      properties: {
        dirId: { type: "string", description: "Profile directory ID (ab_; legacy cb_ IDs are accepted)" },
      },
      required: ["dirId"],
    },
  },
  {
    name: "agent_browser_stop_profile",
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
    name: "agent_browser_status",
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
    name: "agent_browser_list_proxies",
    description: "List all configured SOCKS5/HTTP proxies",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_browser_list_accounts",
    description: "List all stored service account usernames and target platform URLs",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_browser_profile_info",
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
    name: "agent_browser_list_extensions",
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
    name: "agent_browser_install_extension",
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
    name: "agent_browser_delete_extension",
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

// Agent tools exposed over MCP under the agent_browser namespace so external AI can drive a
// launched profile's CDP, query the agent DB, make HTTP calls, etc. Built from
// the real AGENT_TOOLS schemas so they stay in sync.
const MCP_PASSTHROUGH = [
  "browser_navigate", "browser_click", "browser_type", "browser_evaluate",
  "browser_snapshot", "browser_get_text", "browser_get_url", "browser_wait_for_load",
  "browser_screenshot", "browser_scroll", "browser_new_tab", "browser_press_key",
  "http_request", "db_query", "db_exec", "read_file", "write_file", "set_var", "get_var",
];
function publicPassthroughToolName(toolName: string): string {
  const suffix = toolName.startsWith("browser_") ? toolName.slice("browser_".length) : toolName;
  return `agent_browser_${suffix}`;
}
const MCP_PASSTHROUGH_BY_PUBLIC_NAME = new Map(
  MCP_PASSTHROUGH.map((toolName) => [publicPassthroughToolName(toolName), toolName]),
);
const MCP_PASSTHROUGH_DEFS = MCP_PASSTHROUGH.map((toolName) => {
  const t = AGENT_TOOLS.find((x) => x.function.name === toolName);
  return {
    name: publicPassthroughToolName(toolName),
    description: t?.function.description || `Agent tool: ${toolName}`,
    inputSchema: t?.function.parameters || { type: "object", properties: {} },
  };
});
const MCP_EXPANDED_TOOLS = [...MCP_TOOLS, ...MCP_PASSTHROUGH_DEFS,
 { name: "agent_browser_automation_list", description: "List automation rules", inputSchema: { type: "object", properties: {} } },
 { name: "agent_browser_runs_list", description: "List recent agent runs (optionally filtered by profile dirId)", inputSchema: { type: "object", properties: { limit: { type: "number" }, dirId: { type: "string" } } } },
 { name: "agent_browser_jobs_list", description: "List automation jobs", inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "number" } } } },
  { name: "agent_browser_agent_chat", description: "Run a conversation-scoped tool-calling chat against the local agent (persists messages, executes tools, records a run trace); requires a saved LLM config", inputSchema: { type: "object", properties: { conversationId: { type: "string" }, message: { type: "string" }, timeoutMs: { type: "number" } }, required: ["conversationId", "message"] } },
  { name: "agent_browser_agent_chat_simple", description: "One-shot chat without tools; messages is an array of {role, content}", inputSchema: { type: "object", properties: { messages: { type: "array", items: { type: "object" } } }, required: ["messages"] } },
  { name: "agent_browser_conversations_list", description: "List agent conversations (summaries, newest first)", inputSchema: { type: "object", properties: {} } },
  { name: "agent_browser_conversation_create", description: "Create a new agent conversation (optional title)", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "agent_browser_conversation_get", description: "Get a conversation with its full message history", inputSchema: { type: "object", properties: { conversationId: { type: "string" } }, required: ["conversationId"] } },
  { name: "agent_browser_agent_run_get", description: "Get one agent run trace with its tool steps", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } },
  { name: "agent_browser_llm_config", description: "Read the saved LLM config (API key redacted; hasApiKey boolean)", inputSchema: { type: "object", properties: {} } },
  { name: "agent_browser_skills_list", description: "List installed/marketplace agent skills (optional filter by id/name/title/tags)", inputSchema: { type: "object", properties: { filter: { type: "string" } } } },
  { name: "agent_browser_skill_get", description: "Get one agent skill by id", inputSchema: { type: "object", properties: { skillId: { type: "string" } }, required: ["skillId"] } },
  { name: "agent_browser_skill_install", description: "Install an agent skill by id (adds it to the local repository)", inputSchema: { type: "object", properties: { skillId: { type: "string" } }, required: ["skillId"] } },
  { name: "agent_browser_platform_adapters_list", description: "List the AI Skills Hub platform adapter catalog (filter by id/name/category/region/preset/capability)", inputSchema: { type: "object", properties: { filter: { type: "string" } } } },
  { name: "agent_browser_platform_adapter_get", description: "Get one full platform adapter recipe (with loginCheck expression + selectors) by id", inputSchema: { type: "object", properties: { adapterId: { type: "string" }, url: { type: "string", description: "Optional URL to detect the matching adapter instead of a fixed id" } }, required: ["adapterId"] } },
  { name: "agent_browser_platform_adapter_detect", description: "Return the platform adapter that matches a page URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "agent_browser_engine_status", description: "Report browser engine availability (managed Chromium + Firefox) with installed versions", inputSchema: { type: "object", properties: {} } },
  { name: "agent_browser_approvals_list", description: "List pending approval requests (risky agent operations waiting on a decision)", inputSchema: { type: "object", properties: {} } },
  { name: "agent_browser_approval_resolve", description: "Resolve a pending approval request; decision is once, always or deny", inputSchema: { type: "object", properties: { approvalId: { type: "string" }, decision: { type: "string", enum: ["once", "always", "deny"] } }, required: ["approvalId", "decision"] } },
  { name: "agent_browser_db_tables", description: "List agent SQLite tables with row counts", inputSchema: { type: "object", properties: {} } },
];

async function executeMcpTool(name: string, args: any): Promise<any> {
  if (name.startsWith("cloak_")) {
    const legacySuffix = name.slice("cloak_".length);
    name = MCP_PASSTHROUGH.includes(legacySuffix)
      ? publicPassthroughToolName(legacySuffix)
      : `agent_browser_${legacySuffix}`;
  }
  // Passthrough to the agent tool layer (browser_*/db/http/file).
  const passthroughToolName = MCP_PASSTHROUGH_BY_PUBLIC_NAME.get(name);
  if (passthroughToolName) {
    try {
      return await executeToolCall(passthroughToolName, args || {});
    } catch (e: any) {
      return { error: e.message || String(e) };
    }
  }
  switch (name) {
    case "agent_browser_list_profiles": {
      const browserProfiles = listBrowserProfiles();
      return {
        profiles: browserProfiles.map(p => ({
          dirId: p.dirId, name: p.name, browser: "chromium",
          running: p.running,
          proxyMode: p.proxyMode,
          proxy: p.proxyMode === "none" ? "(no proxy)" : (p.proxyName || "(missing proxy)"),
          sizeMB: "0",
        })),
        binary: { path: findRuntimeChromiumBinary(), version: getRuntimeChromiumVersion() },
      };
    }
    case "agent_browser_launch_profile": {
      validateDirId(args.dirId);
      try {
        const result = await launchBrowser(args.dirId);
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
    case "agent_browser_stop_profile": {
      validateDirId(args.dirId);
      const result = stopBrowser(args.dirId);
      return { success: result };
    }
    case "agent_browser_status": {
      validateDirId(args.dirId);
      const status = statusBrowser(args.dirId);
      return {
        running: status.running,
        pid: status.pid,
        cdpPort: status.cdpPort,
        dirId: args.dirId,
      };
    }
    case "agent_browser_list_proxies": {
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
    case "agent_browser_list_accounts": {
      return { accounts: getAccounts().map(a => ({ url: a.platformUrl, username: a.platformUserName, tags: a.tags })) };
    }
    case "agent_browser_profile_info": {
      validateDirId(args.dirId);
      const meta = getProfileMeta(args.dirId);
      const status = statusBrowser(args.dirId);
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
    case "agent_browser_list_extensions": {
      validateDirId(args.dirId);
      const cfg = getConfig() as any;
      const enabledMap = cfg.browserProfiles?.[args.dirId]?.extensions || {};
      return {
        extensions: listExtensionRepository().map((entry) => ({
          ...entry,
          enabled: enabledMap[entry.id] === true,
        })),
        dirId: args.dirId,
      };
    }
    case "agent_browser_install_extension": {
      validateDirId(args.dirId);
      validateExtensionId(args.extId);
      try {
        assertBrowserProfileExists(args.dirId);
        const entry = await addOrUpdateChromeStoreExtension(args.extId);
        setProfileExtensionEnabled(args.dirId, args.extId, true);
        return { success: true, extId: args.extId, dirId: args.dirId, extension: entry };
      } catch (e: any) {
        return { success: false, error: e.message || String(e) };
      }
    }
    case "agent_browser_delete_extension": {
      validateDirId(args.dirId);
      validateExtensionId(args.extId);
      setProfileExtensionEnabled(args.dirId, args.extId, false);
      return { success: true, extId: args.extId, dirId: args.dirId };
    }
    case "agent_browser_automation_list": {
      return { rules: (getConfig() as any).automation || [] };
    }
    case "agent_browser_runs_list": {
      return { runs: agentRunRecorder.listRuns({ dirId: args?.dirId }).slice(0, Math.max(1, Math.min(args?.limit ?? 50, 200))) };
    }
   case "agent_browser_jobs_list": {
     return { jobs: listJobs({ status: args?.status, limit: args?.limit }) };
   }
    case "agent_browser_llm_config": {
      return { config: redactLlmConfig(getLlmConfig()) };
    }
    case "agent_browser_conversations_list": {
      return {
        conversations: listConversations().map((c: any) => ({
          id: c.id, title: c.title, messageCount: c.messages.length, createdAt: c.createdAt, updatedAt: c.updatedAt,
        })),
      };
    }
    case "agent_browser_conversation_create": {
      const title = typeof args?.title === "string" && args.title.trim()
        ? args.title.trim().slice(0, 200) : undefined;
      const c = createConversation(title);
      return { conversation: { id: c.id, title: c.title, messageCount: 0, createdAt: c.createdAt, updatedAt: c.updatedAt } };
    }
    case "agent_browser_conversation_get": {
      const c = getConversation(args?.conversationId);
      if (!c) return { error: "Conversation not found" };
      return { conversation: c };
    }
    case "agent_browser_agent_run_get": {
      const run = agentRunRecorder.getRun(args?.runId);
      if (!run) return { error: "Run not found" };
      return { run };
    }
    case "agent_browser_agent_chat_simple": {
      const msgsIn = args?.messages;
      if (!Array.isArray(msgsIn) || msgsIn.length === 0) return { error: "messages array is required" };
      const config = getLlmConfig() || getOrDetectLlmConfig();
      if (!config) return { error: "No LLM config. Configure an API key first." };
      const msgs: LlmMessage[] = [];
      for (const m of msgsIn) {
        if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "system") || typeof m.content !== "string") {
          return { error: "each message needs a valid role and string content" };
        }
        msgs.push({ role: m.role, content: m.content });
      }
      try {
        const reply = await llmChat(config, msgs);
        return { reply: reply.content };
      } catch (e: any) {
        return { error: e.message || String(e) };
      }
    }
    case "agent_browser_agent_chat": {
      const deniedChat = denyMcpMutation();
      if (deniedChat) return { error: deniedChat };
      const conversationId = args?.conversationId;
      const message = args?.message;
      if (typeof conversationId !== "string" || !conversationId || typeof message !== "string" || !message) {
        return { error: "conversationId and message are required" };
      }
      const config = getLlmConfig() || getOrDetectLlmConfig();
      if (!config) return { error: "No LLM config. Configure an API key first." };
      const conv = getConversation(conversationId);
      if (!conv) return { error: "Conversation not found" };

      addMessage(conversationId, "user", message);
      const recentMsgs = conv.messages
        .filter((m: any) => m.role === "user" || m.role === "assistant")
        .slice(-40);
      const llmMsgs: LlmMessage[] = recentMsgs.map((m: any) => ({ role: m.role, content: m.content }));
      llmMsgs.push({ role: "user", content: message });
      const repaired = repairMessageSequence(llmMsgs);

      const timeoutMs = Math.max(1000, Math.min(Number(args?.timeoutMs) || 120000, 600000));
      const run = agentRunRecorder.startRun({
        source: { type: "chat", conversationId },
        name: message.slice(0, 120),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await agentChat(config, repaired, { runId: run.id, signal: controller.signal });
        agentRunRecorder.finishRun(run.id, "done");
        if (result.error) {
          addMessage(conversationId, "assistant", "❌ " + result.error, []);
          return { error: result.error, runId: run.id };
        }
        const finalMsg = [...result.messages].reverse().find((m: any) => m.role === "assistant" && m.content);
        if (!finalMsg?.content) {
          addMessage(conversationId, "assistant", "❌ Agent did not return a final response.", []);
          return { error: "Agent did not return a final response.", runId: run.id };
        }
        const redactedToolCalls = result.messages.flatMap((m: any) =>
          m.tool_calls?.map((tc: any) => ({ name: tc.function.name, redacted: true })) || []);
        addMessage(conversationId, "assistant", finalMsg.content, redactedToolCalls);
        return { reply: finalMsg.content, toolCalls: redactedToolCalls, runId: run.id, conversationId };
      } catch (e: any) {
        const errMsg = controller.signal.aborted
          ? "Agent chat timed out after " + timeoutMs + "ms"
          : (e.message || String(e));
        agentRunRecorder.finishRun(run.id, "error", errMsg);
        addMessage(conversationId, "assistant", "❌ " + errMsg, []);
        return { error: errMsg, runId: run.id };
      } finally {
        clearTimeout(timer);
      }
    }
    case "agent_browser_skills_list": {
      return { skills: listSkillRepository(args?.filter) };
    }
    case "agent_browser_skill_get": {
      const skill = getSkill(args?.skillId);
      if (!skill) return { error: "Skill not found" };
      return { skill };
    }
    case "agent_browser_skill_install": {
      try {
        const skill = installSkill(args?.skillId);
        return { success: true, skill };
      } catch (e: any) {
        return { error: e.message || String(e) };
      }
    }
    case "agent_browser_platform_adapters_list": {
      return { adapters: listPlatformAdapters(args?.filter) };
    }
    case "agent_browser_platform_adapter_get": {
      if (args?.url) {
        const adapter = getPlatformAdapter(detectAdapter(args.url).id);
        return adapter ? { adapter } : { error: "Adapter not found" };
      }
      const adapter = getPlatformAdapter(args?.adapterId);
      if (!adapter) return { error: "Adapter not found" };
      return { adapter };
    }
    case "agent_browser_platform_adapter_detect": {
      if (typeof args?.url !== "string" || !args.url) return { error: "url is required" };
      return { adapter: getPlatformAdapter(detectAdapter(args.url).id) };
    }
    case "agent_browser_engine_status": {
      const status = getEngineStatus();
      return { chromium: status.chromium, firefox: status.firefox };
    }
    case "agent_browser_approvals_list": {
      return { approvals: listPendingApprovals() };
    }
    case "agent_browser_approval_resolve": {
      // No programmatic self-approval (R4 #64): an MCP client resolving its
      // own agent_chat approval would defeat the human-in-the-loop gate the
      // approval exists for. Deny is safe (refuse); allow-decisions must come
      // from the UI (IPC approval:resolve with confirmed+sender).
      const id = args?.approvalId;
      const decision = args?.decision;
      if (typeof id !== "string" || !id) return { error: "approvalId is required" };
      if (decision !== "once" && decision !== "always" && decision !== "deny") {
        return { error: "decision must be once, always or deny" };
      }
      if (decision === "deny") {
        const ok = resolveApproval(id, decision);
        if (!ok) return { error: "Approval request not found" };
        return { success: true, approvalId: id, decision };
      }
      return { error: "Approval allow-decisions must come from the UI approval dialog (human-in-the-loop); MCP may only deny" };
    }
    case "agent_browser_db_tables": {
      return { tables: agentDbTables() };
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
        serverInfo: { name: "agent-browser-studio", version: "1.0.0" },
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Authorization, X-Agent-Browser-Token, X-Cloak-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (isMcpRateLimited(mcpRateKey(req))) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests" }));
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
      let json: any;
      try {
        json = JSON.parse(body);
      } catch {
        // Malformed JSON is a client error (R7 #38) — never silently treat
        // it as an empty request the way safeJson did (200 result:null).
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } }));
        return;
      }
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
      res.end(JSON.stringify({ status: "ok", service: "agent-browser-studio-mcp", port: mcpPort }));
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
      let json: any;
      try {
        json = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON" } }));
        return;
      }
      if (json.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: json.id,
          result: { protocolVersion: "2024-11-05", serverInfo: { name: "agent-browser-studio", version: "1.0.0" }, capabilities: { tools: {} } },
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

function assertBrowserProfileExists(dirId: string): void {
  const cfg = getConfig() as any;
  if (!cfg.browserProfiles?.[dirId]) throw new Error("Browser profile not found");
}

function setProfileExtensionEnabled(dirId: string, extId: string, enabled: boolean): void {
  const cfg = structuredClone(getConfig()) as any;
  const profile = cfg.browserProfiles?.[dirId];
  if (!profile) throw new Error("Browser profile not found");
  profile.extensions = { ...(profile.extensions || {}), [extId]: enabled };
  saveConfig(cfg);
}

function validateExtensionId(extId: string): void {
  if (!/^[a-p]{32}$/.test(extId)) {
    throw new Error(`Invalid extension ID: ${JSON.stringify(extId)}`);
  }
}


const MCP_RATE_MAX = 120;
const MCP_RATE_WINDOW_MS = 60_000;
const mcpRateMap = new Map<string, number[]>();
function isMcpRateLimited(key: string): boolean {
  const now = Date.now();
  const arr = (mcpRateMap.get(key) || []).filter(t => now - t < MCP_RATE_WINDOW_MS);
  arr.push(now);
  mcpRateMap.set(key, arr);
  if (arr.length > MCP_RATE_MAX) return true;
  if (mcpRateMap.size > 200) {
    for (const [k, v] of mcpRateMap) if (!v.length || now - Math.max(...v) > MCP_RATE_WINDOW_MS) mcpRateMap.delete(k);
  }
  return false;
}
function mcpRateKey(req: import("node:http").IncomingMessage): string {
  const ip = (req.socket && (req.socket as any).remoteAddress) || "127.0.0.1";
  try { return ip + ":" + new URL(req.url || "/", "http://127.0.0.1").pathname; } catch { return ip; }
}

function isAuthorized(req: http.IncomingMessage, _url: URL): boolean {
  return isAuthorizedShared(req, MCP_TOKEN);
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

async function readBody(req: http.IncomingMessage): Promise<string> {
  const buf = await httpReadBody(req as any, { maxBytes: 1 * 1024 * 1024 });
  return buf.toString("utf-8");
}

/**
 * Lenient JSON parse for NON-request paths only (SSE payloads etc.). Request
 * bodies must use strict JSON.parse with a 400 on failure (R7 #38) — a
 * malformed request silently becoming {} turns protocol errors into
 * confusing downstream behavior (200 result:null).
 */
function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return {}; }
}
