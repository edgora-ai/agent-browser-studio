// ── Agent Browser Studio Local REST API ──
// Loopback JSON REST server exposing the same service layer as the MCP server,
// plus an OpenAPI 3.0 document for SDK/tooling generation. Token-auth'd
// (AGENT_BROWSER_API_TOKEN / CLOAK_API_TOKEN, or a generated local token).
// Open endpoints: GET /health and GET /openapi.json (loopback only).

import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { isAuthorized as isAuthorizedShared } from "./http/auth.js";
import { readJson as readJsonShared, HttpError } from "./http/body.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getConfig, getProxyList, addProxy, deleteProxy, updateProxy,
  setDefaultProxyName, getProxyRotationInfo, getProfileMeta,
  resolveProfileProxy, saveConfig, getAppDataDir,
} from "./config-manager.js";
import { listProxyHealth, proxyHealthSummary, recordProxyRotation } from "./proxy-health.js";
import { parseProxyText, importProxies, exportProxiesCsv } from "./proxy-import.js";
import { getDrmStatus, setProfileDrm, ensureManagedCdm } from "./drm.js";
import { checkForUpdates, installRelease, activateVersion, rollback, getUpdateState, getCurrentVersion, assertSafeManifestUrl } from "./update-manager.js";
import { teamStatus, initTeam, addMember, removeMember, setMemberRole, renameWorkspace, setTeamEnabled, requireAccountMutation, requireAccountSecret, requireSettingsMutation } from "./team.js";
import { isHeadlessMode } from "./server-mode.js";
import { setDrmCdmPath } from "./config-manager.js";
import {
  getAccounts, getAccountPassword, addAccount, updateAccount, deleteAccount,
  parseAccountsBulkText, bulkAddAccounts, bulkCreateProfilesWithAccounts,
} from "./local-agent.js";
import {
  getLlmConfig, getOrDetectLlmConfig, redactLlmConfig, saveLlmConfig,
  listConversations, createConversation, getConversation, deleteConversation,
  renameConversation, llmChat, agentChat, addMessage, repairMessageSequence,
  type LlmMessage,
} from "./local-agent.js";
import { listAudit, clearAudit, recordAudit } from "./audit-log.js";
import { listJobs, markCancelled, type JobStatus } from "./job-store.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import { agentDbTables, agentDbTableData, agentDbQuery, agentDbExecScript } from "./agent-db.js";
import { listPendingApprovals, resolveApproval } from "./approval-gate.js";
import {
  listExtensionRepository, addOrUpdateChromeStoreExtension, installLocalExtension,
  updateRepositoryExtension, deleteRepositoryExtension, setRepositoryExtensionMeta,
  getRepositoryExtension,
} from "./extension-repository.js";
import { listSkillRepository, addOrUpdateSkill, installSkill, removeSkill, setSkillMeta } from "./skill-repository.js";
import { listPlatformAdapters, getPlatformAdapter, detectAdapter } from "./platform-adapters.js";
import { createAutomationRule, updateAutomationRule, deleteAutomationRule } from "./automation-rules.js";
import {
  listBrowserProfiles, launchBrowser, stopBrowser, statusBrowser, checkFingerprintDrift,
  createBrowserProfile, deleteBrowserProfile, getEngineStatus,
  findRuntimeChromiumBinary, getRuntimeChromiumVersion,
  touchProfileActivity, listRunningProfileIdle, getIdlePolicyTimeoutMs,
} from "./browser-manager.js";
import { validateDirId } from "./utils.js";
import { checkEnvironmentRisk, checkEnvironmentRiskRuntime } from "./environment-risk.js";
import { getProfileEngineByDirId } from "./page-eval.js";
import { exportProfileArchive, importProfileArchive, exportProfileArchives, importProfileArchives } from "./profile-archive.js";
import { assertSafeArchiveExportDir, assertSafeArchiveExportPath, assertSafeArchiveImportPath } from "./archive-path-guard.js";
import { syncService } from "./sync-service.js";
import { retryAgentRun, retryJobRuns, testRunRule, reloadSchedule, cancelRunningJob } from "./automation.js";
import { PRODUCT_NAME, PRODUCT_SLUG } from "../branding.js";

const API_VERSION = "1.0.0";
let server: http.Server | null = null;
let serverListening = false;
const API_DEFAULT_PORT = 26582;
let apiPort = configuredApiPort();
const PLACEHOLDER_TOKENS = new Set(["change-me", "changeme", "token", "test", "password", "secret"]);
function resolveApiToken(): string {
  const fromEnv = process.env.AGENT_BROWSER_API_TOKEN || process.env.CLOAK_API_TOKEN;
  // Fail closed on placeholder credentials: a shipped "change-me" on published
  // ports is worse than no server. Docker/headless deployments must export a
  // real token; desktop use falls back to a per-boot random local token.
  if (fromEnv && PLACEHOLDER_TOKENS.has(fromEnv.trim().toLowerCase())) {
    throw new Error("Refusing to start with a placeholder API token (AGENT_BROWSER_API_TOKEN=change-me). Set a real token.");
  }
  return fromEnv || createLocalToken();
}
const API_TOKEN = resolveApiToken();

function configuredApiPort(): number {
  const value = Number(process.env.AGENT_BROWSER_API_PORT ?? process.env.CLOAK_API_PORT ?? API_DEFAULT_PORT);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : API_DEFAULT_PORT;
}

// ═══════════════════════════════════════════════════════════════
// Request dispatch
// ═══════════════════════════════════════════════════════════════

interface JsonResponse { status: number; body: any; }

function profileSummary(p: any): any {
  return {
    dirId: p.dirId,
    name: p.name,
    engine: p.engine === "firefox" ? "firefox" : "chromium",
    browser: p.engine === "firefox" ? "firefox" : "chromium",
    running: Boolean(p.running),
    proxyMode: p.proxyMode,
    proxy: p.proxyMode === "none" ? null : (p.proxyName || null),
    version: p.version || getRuntimeChromiumVersion() || "?",
    tags: Array.isArray(p.tags) ? p.tags : [],
  };
}

function proxyInfo(name: string): any {
  const cfg = getConfig() as any;
  const p = cfg.proxies?.[name];
  if (!p) return null;
  return {
    name,
    type: p.type,
    host: p.host,
    port: p.port,
    hasAuth: Boolean(p.username),
    bypassList: Array.isArray(p.bypassList) ? p.bypassList : [],
    fallbacks: Array.isArray(p.fallbacks) ? p.fallbacks : [],
    isDefault: cfg.defaultProxy === name,
  };
}

function requireRestAccountMutation(): { status: number; body: any } | null {
  const r = requireAccountMutation();
  return r.ok ? null : { status: 403, body: { error: r.error } };
}

function requireRestAccountSecret(): { status: number; body: any } | null {
  const r = requireAccountSecret();
  return r.ok ? null : { status: 403, body: { error: r.error } };
}

function requireRestSettingsMutation(): { status: number; body: any } | null {
  const r = requireSettingsMutation();
  return r.ok ? null : { status: 403, body: { error: r.error } };
}

// Map a service-layer "not found" error to a 404 instead of a generic 400.
function notFoundStatus(error: unknown): { status: number; body: any } {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|not in the repository|does not exist/i.test(message)) {
    return { status: 404, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

function redactRestAccount(account: any, index: number): any {
  return {
    index,
    url: account.platformUrl,
    username: account.platformUserName,
    profileIds: Array.isArray(account.profileIds) ? account.profileIds : [],
    tags: Array.isArray(account.tags) ? account.tags : [],
    hasPassword: Boolean(account.platformPassword),
  };
}

function normalizeRestProfileIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const clean = value
    .filter((v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v))
    .filter((v) => !seen.has(v) && (seen.add(v), true))
    .slice(0, 200);
  return clean.length ? clean : undefined;
}

function normalizeRestTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = [...new Set(
    value.filter((v) => typeof v === "string").map((v) => v.trim().slice(0, 40)).filter(Boolean),
  )].slice(0, 20);
  return clean.length ? clean : undefined;
}

function conversationSummary(c: any): any {
  return {
    id: c.id,
    title: c.title,
    messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function normalizeLlmConfig(body: any): import("../types.js").LlmConfig | null {
  if (!body || typeof body !== "object") return null;
  const provider = body.provider === "openai" || body.provider === "claude" || body.provider === "custom"
    ? body.provider
    : "openai";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const apiUrl = typeof body.apiUrl === "string" && body.apiUrl.trim() ? body.apiUrl.trim() : undefined;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (!apiKey) return null;
  return { provider, apiKey, apiUrl, model };
}


async function handleRequest(req: http.IncomingMessage, url: URL): Promise<JsonResponse> {
  const method = req.method || "GET";
  const p = url.pathname || "/";

  // Any REST interaction with a profile counts as activity so the server/headless
  // idle sweep never stops a profile a client is still using.
  const mProfileRoute = p.match(/^\/api\/profiles\/([^/]+)(\/|$)/);
  if (mProfileRoute && mProfileRoute[1] !== "import" && mProfileRoute[1] !== "import-batch" && mProfileRoute[1] !== "export") {
    try { touchProfileActivity(mProfileRoute[1]); } catch { /* best effort */ }
  }

  if (method === "GET" && p === "/health") {
    return {
      status: 200,
      body: {
        status: "ok",
        service: PRODUCT_SLUG + "-api",
        port: apiPort,
        mode: isHeadlessMode() ? "headless" : "gui",
        version: API_VERSION,
        profiles: Object.keys(getConfig().browserProfiles || {}).length,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };
  }
  if (method === "GET" && p === "/api/server/idle") {
    const timeoutMs = getIdlePolicyTimeoutMs();
    return {
      status: 200,
      body: {
        enabled: timeoutMs > 0,
        timeoutMs,
        running: listRunningProfileIdle(),
      },
    };
  }
  if (method === "GET" && p === "/openapi.json") {
    return { status: 200, body: buildOpenApi() };
  }
  if (method === "GET" && p === "/version") {
    return {
      status: 200,
      body: {
        name: PRODUCT_NAME,
        slug: PRODUCT_SLUG,
        version: API_VERSION,
        chromium: { path: findRuntimeChromiumBinary(), version: getRuntimeChromiumVersion() },
      },
    };
  }

  // ── Profiles ──
  if (method === "GET" && p === "/api/profiles") {
    return { status: 200, body: { profiles: listBrowserProfiles().map(profileSummary) } };
  }
  if (method === "POST" && p === "/api/profiles") {
    const opts = await readJson(req);
    if (!opts || typeof opts.name !== "string" || !opts.name.trim()) {
      return { status: 400, body: { error: "name is required" } };
    }
    try {
      const r = createBrowserProfile(sanitizeProfileOpts(opts));
      recordAudit({ category: "profile", action: "create", target: r.dirId, actor: "api", detail: "created profile via API" });
      return { status: 201, body: { success: true, dirId: r.dirId } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  const mExtList = p.match(/^\/api\/profiles\/([^/]+)\/extensions$/);
  if (mExtList && method === "GET") {
    try {
      const dirId = mExtList[1];
      validateDirId(dirId);
      const cfg = getConfig() as any;
      const enabledMap = cfg.browserProfiles?.[dirId]?.extensions || {};
      return {
        status: 200,
        body: {
          dirId,
          extensions: listExtensionRepository().map((entry) => ({ ...entry, enabled: enabledMap[entry.id] === true })),
        },
      };
    } catch (e: any) {
      return { status: 404, body: { error: e.message || String(e) } };
    }
  }

  const mExtInstall = p.match(/^\/api\/profiles\/([^/]+)\/extensions\/([^/]+)\/install$/);
  if (mExtInstall && method === "POST") {
    try {
      const dirId = mExtInstall[1];
      const extId = mExtInstall[2];
      validateDirId(dirId);
      validateExtensionId(extId);
      assertProfileExists(dirId);
      const entry = await addOrUpdateChromeStoreExtension(extId);
      setProfileExtensionEnabled(dirId, extId, true);
      recordAudit({ category: "profile", action: "extension.install", target: dirId, actor: "api", detail: "installed " + extId });
      return { status: 200, body: { success: true, dirId, extId, extension: entry } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  const mExtDelete = p.match(/^\/api\/profiles\/([^/]+)\/extensions\/([^/]+)$/);
  if (mExtDelete && method === "DELETE") {
    try {
      const dirId = mExtDelete[1];
      const extId = mExtDelete[2];
      validateDirId(dirId);
      validateExtensionId(extId);
      setProfileExtensionEnabled(dirId, extId, false);
      recordAudit({ category: "profile", action: "extension.delete", target: dirId, actor: "api", detail: "removed " + extId });
      return { status: 200, body: { success: true, dirId, extId } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  const mLaunch = p.match(/^\/api\/profiles\/([^/]+)\/launch$/);
  if (mLaunch && method === "POST") {
    try {
      const dirId = mLaunch[1];
      validateDirId(dirId);
      const opts = await readJson(req);
      const r = await launchBrowser(dirId, { headless: Boolean(opts && opts.headless) });
      recordAudit({ category: "profile", action: "launch", target: dirId, actor: "api" });
      return { status: 200, body: { success: true, dirId, pid: r.pid, cdpPort: r.cdpPort, driftCheck: r.driftCheck, envCheck: r.envCheck, cookieCheck: (r as any).cookieCheck ?? { checked: false } } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mStop = p.match(/^\/api\/profiles\/([^/]+)\/stop$/);
  if (mStop && method === "POST") {
    try {
      const dirId = mStop[1];
      validateDirId(dirId);
      const ok = stopBrowser(dirId);
      recordAudit({ category: "profile", action: "stop", target: dirId, actor: "api" });
      return { status: 200, body: { success: ok, dirId } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mStatus = p.match(/^\/api\/profiles\/([^/]+)\/status$/);
  if (mStatus && method === "GET") {
    try {
      const dirId = mStatus[1];
      validateDirId(dirId);
      const st = statusBrowser(dirId);
      return { status: 200, body: { dirId, running: st.running, pid: st.pid, cdpPort: st.cdpPort } };
    } catch (e: any) {
      return { status: 404, body: { error: e.message || String(e) } };
    }
  }
  const mEnvRisk = p.match(/^\/api\/profiles\/([^/]+)\/env-risk$/);
  if (mEnvRisk && method === "GET") {
    try {
      const dirId = mEnvRisk[1];
      validateDirId(dirId);
      const meta = getProfileMeta(dirId);
      if (!meta) return { status: 404, body: { error: "Profile not found" } };
      const st = statusBrowser(dirId);
      const profile = { timezone: meta.timezone, locale: meta.locale, platform: meta.platform };
      if (st.running && st.cdpPort) return { status: 200, body: await checkEnvironmentRiskRuntime(profile, st.cdpPort, {}, getProfileEngineByDirId(dirId)) };
      return { status: 200, body: checkEnvironmentRisk(profile) };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mDrift = p.match(/^\/api\/profiles\/([^/]+)\/drift$/);
  if (mDrift && method === "GET") {
    try {
      const dirId = mDrift[1];
      validateDirId(dirId);
      return { status: 200, body: await checkFingerprintDrift(dirId) };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Profile backup (export / import via REST) ──
  // Note: /api/profiles/import must be matched before /api/profiles/{dirId}.
  if (method === "POST" && p === "/api/profiles/import") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body.zipPath !== "string" || !body.zipPath.trim()) {
      return { status: 400, body: { error: "zipPath is required" } };
    }
    let zipPath: string;
    try {
      zipPath = assertSafeArchiveImportPath(body.zipPath);
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
    try {
      const r = importProfileArchive(zipPath);
      recordAudit({ category: "profile", action: "import", target: r.dirId, actor: "api", detail: "imported " + zipPath });
      return { status: 200, body: { success: true, dirId: r.dirId, name: r.name, files: r.files, bytes: r.bytes } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  // Batch import of several profile backup ZIPs.
  if (method === "POST" && p === "/api/profiles/import-batch") {
    const body = await readJson(req).catch(() => null);
    if (!body || !Array.isArray(body.zipPaths) || !body.zipPaths.length) {
      return { status: 400, body: { error: "zipPaths (non-empty array) is required" } };
    }
    const raw = body.zipPaths.filter((z: any) => typeof z === "string");
    let validated: string[] = [];
    for (const z of raw) {
      try {
        validated.push(assertSafeArchiveImportPath(z));
      } catch (e: any) {
        return { status: 400, body: { error: e?.message || String(e), zipPath: z } };
      }
    }
    const report = importProfileArchives(validated);
    recordAudit({ category: "profile", action: "import-batch", actor: "api", detail: "imported " + report.imported.length + ", failed " + report.failed.length });
    return { status: 200, body: { success: true, report } };
  }
  // Batch export of several stopped profiles into one directory.
  if (method === "POST" && p === "/api/profiles/export") {
    try {
      const body = await readJson(req).catch(() => null);
      if (!body || !Array.isArray(body.dirIds) || !body.dirIds.length) {
        return { status: 400, body: { error: "dirIds (non-empty array) is required" } };
      }
      const destDirRaw = typeof body?.destDir === "string" && body.destDir.trim() ? body.destDir : defaultBackupPathForBatch();
      let destDir: string;
      try {
        destDir = assertSafeArchiveExportDir(destDirRaw);
      } catch (e: any) {
        return { status: 400, body: { error: e?.message || String(e) } };
      }
      const report = await exportProfileArchives(body.dirIds.filter((d: any) => typeof d === "string"), destDir);
      recordAudit({ category: "profile", action: "export-batch", actor: "api", detail: "exported " + report.exported.length + ", skipped " + report.skipped.length + ", failed " + report.failed.length });
      return { status: 200, body: { success: true, destDir, report } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mExport = p.match(/^\/api\/profiles\/([^/]+)\/export$/);
  if (mExport && method === "POST") {
    try {
      const dirId = mExport[1];
      validateDirId(dirId);
      const body = await readJson(req).catch(() => null);
      const destPathRaw = typeof body?.destPath === "string" && body.destPath.trim() ? body.destPath : defaultBackupPath(dirId);
      let destPath: string;
      try {
        destPath = assertSafeArchiveExportPath(destPathRaw);
      } catch (e: any) {
        return { status: 400, body: { error: e?.message || String(e) } };
      }
      const r = await exportProfileArchive(dirId, destPath);
      recordAudit({ category: "profile", action: "export", target: dirId, actor: "api", detail: r.filePath });
      return { status: 200, body: { success: true, filePath: r.filePath, entries: r.entries, bytes: r.bytes } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  const mProfile = p.match(/^\/api\/profiles\/([^/]+)$/);
  if (mProfile && method === "GET") {
    try {
      const dirId = mProfile[1];
      validateDirId(dirId);
      const meta = getProfileMeta(dirId);
      if (!meta) return { status: 404, body: { error: "Profile not found" } };
      const st = statusBrowser(dirId);
      const resolvedProxy = resolveProfileProxy(dirId);
      return {
        status: 200,
        body: {
          ...meta,
          dirId,
          running: st.running,
          pid: st.pid,
          cdpPort: st.cdpPort,
          proxyMode: resolvedProxy.mode,
          proxyName: resolvedProxy.name,
          proxy: resolvedProxy.config ? {
            type: resolvedProxy.config.type,
            host: resolvedProxy.config.host,
            port: resolvedProxy.config.port,
            hasAuth: Boolean(resolvedProxy.config.username),
            bypassList: resolvedProxy.config.bypassList || [],
          } : null,
        },
      };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (mProfile && method === "DELETE") {
    try {
      const dirId = mProfile[1];
      validateDirId(dirId);
      const ok = deleteBrowserProfile(dirId);
      recordAudit({ category: "profile", action: "delete", target: dirId, actor: "api" });
      return { status: 200, body: { success: ok, dirId } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  const mProfileDrm = p.match(/^\/api\/profiles\/([^/]+)\/drm$/);
  if (mProfileDrm && method === "POST") {
    try {
      const dirId = mProfileDrm[1];
      const body = await readJson(req);
      validateDirId(dirId);
      const enabled = !!(body && body.enabled);
      setProfileDrm(dirId, enabled);
      recordAudit({ category: "profile", action: enabled ? "drm-enable" : "drm-disable", target: dirId, actor: "api" });
      return { status: 200, body: { success: true, dirId, enabled } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Proxies ──
  if (method === "GET" && p === "/api/proxies") {
    return { status: 200, body: { proxies: getProxyList() } };
  }
  if (method === "POST" && p === "/api/proxies") {
    const body = await readJson(req);
    if (!body || typeof body.name !== "string" || !body.name.trim() || !body.config || typeof body.config !== "object") {
      return { status: 400, body: { error: "name and config are required" } };
    }
    try {
      addProxy(body.name, body.config);
      recordAudit({ category: "proxy", action: "add", target: body.name, actor: "api", detail: "added via API" });
      return { status: 201, body: { success: true, name: body.name } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (method === "GET" && p === "/api/proxies/health") {
    return { status: 200, body: { entries: listProxyHealth(), summary: proxyHealthSummary() } };
  }
  if (method === "POST" && p === "/api/proxies/import") {
    const body = await readJson(req);
    if (!body || typeof body.text !== "string") {
      return { status: 400, body: { error: "text is required" } };
    }
    try {
      const parsed = parseProxyText(body.text);
      const report = importProxies(parsed.proxies, { replace: !!body.replace });
      report.failed = report.failed.concat(parsed.errors.map((e) => ({ line: e.line, error: e.error })));
      recordAudit({ category: "proxy", action: "import", target: report.imported.length + " proxies", actor: "api", detail: `imported ${report.imported.length}, skipped ${report.skipped.length}, failed ${report.failed.length}` });
      return { status: 200, body: { success: true, report } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (method === "GET" && p === "/api/proxies/export") {
    try {
      const includePasswords = String(url.searchParams.get("includePasswords") || "").toLowerCase() === "true";
      // Bulk password export is a secret operation (R2 #51): same gate as the
      // single-account password endpoint. Redacted export stays open.
      if (includePasswords) {
        const deny = requireRestAccountSecret();
        if (deny) return deny;
      }
      recordAudit({ category: "proxy", action: "export", target: "proxies", actor: "api", detail: includePasswords ? "exported CSV (passwords included)" : "exported CSV (passwords redacted)" });
      return { status: 200, body: { success: true, csv: exportProxiesCsv({ includePasswords }) } };
    } catch (e: any) {
      return { status: 500, body: { error: e.message || String(e) } };
    }
  }

  // ── Widevine/DRM ──
  if (method === "GET" && p === "/api/drm/status") {
    return { status: 200, body: { success: true, status: getDrmStatus() } };
  }
  if (method === "POST" && p === "/api/drm/cdm-path") {
    const body = await readJson(req);
    const cdmPath = body && typeof body.cdmPath === "string" ? body.cdmPath : null;
    const cfg = setDrmCdmPath(cdmPath);
    recordAudit({ category: "settings", action: "drm-cdm-path", target: cfg.cdmPath || "auto", actor: "api" });
    return { status: 200, body: { success: true, configuredPath: cfg.cdmPath || null } };
  }
  if (method === "POST" && p === "/api/drm/ensure") {
    const cdm = ensureManagedCdm();
    return { status: 200, body: { success: true, staged: !!cdm, status: getDrmStatus() } };
  }


  // ── Team workspace RBAC ──
  if (method === "GET" && p === "/api/team") {
    return { status: 200, body: { success: true, ...teamStatus() } };
  }
  if (method === "POST" && p === "/api/team/init") {
    try {
      const body = await readJson(req);
      const team = initTeam(body?.name);
      recordAudit({ category: "team", action: "team-init", target: team.ownerDeviceId, actor: "api" });
      return { status: 200, body: { success: true, team } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/team/members") {
    try {
      const body = await readJson(req);
      const r = addMember(body?.deviceId, body?.name, body?.role);
      if (!r.ok) return { status: 403, body: { error: r.error } };
      recordAudit({ category: "team", action: "member-add", target: body?.deviceId, actor: "api" });
      return { status: 200, body: { success: true, team: r.team } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  const mTeamMember = p.match(/^\/api\/team\/members\/([^/]+)$/);
  if (mTeamMember && method === "DELETE") {
    try {
      const r = removeMember(decodeURIComponent(mTeamMember[1]));
      if (!r.ok) return { status: 403, body: { error: r.error } };
      recordAudit({ category: "team", action: "member-remove", target: decodeURIComponent(mTeamMember[1]), actor: "api" });
      return { status: 200, body: { success: true, team: r.team } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  const mTeamRole = p.match(/^\/api\/team\/members\/([^/]+)\/role$/);
  if (mTeamRole && method === "PUT") {
    try {
      const body = await readJson(req);
      const r = setMemberRole(decodeURIComponent(mTeamRole[1]), body?.role);
      if (!r.ok) return { status: 403, body: { error: r.error } };
      recordAudit({ category: "team", action: "member-role", target: decodeURIComponent(mTeamRole[1]), actor: "api" });
      return { status: 200, body: { success: true, team: r.team } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/team/rename") {
    try {
      const body = await readJson(req);
      const r = renameWorkspace(body?.name);
      if (!r.ok) return { status: 403, body: { error: r.error } };
      return { status: 200, body: { success: true, team: r.team } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  // ── Version-aware updates (release store with pin + rollback) ──
  if (method === "GET" && p === "/api/updates/status") {
    return { status: 200, body: { success: true, currentVersion: getCurrentVersion(), state: getUpdateState() } };
  }
  if (method === "POST" && p === "/api/updates/check") {
    try {
      const body = await readJson(req);
      let safeUrl: string | undefined;
      if (body?.manifestUrl != null && body.manifestUrl !== "") {
        safeUrl = await assertSafeManifestUrl(String(body.manifestUrl));
      }
      const result = await checkForUpdates(safeUrl);
      return { status: 200, body: { success: true, ...result } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/updates/install") {
    try {
      const body = await readJson(req);
      const state = await installRelease(body?.version);
      return { status: 200, body: { success: true, state } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/updates/activate") {
    try {
      const body = await readJson(req);
      const state = activateVersion(body?.version);
      recordAudit({ category: "updates", action: "activate", target: body?.version, actor: "api" });
      return { status: 200, body: { success: true, state } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/updates/rollback") {
    try {
      const state = rollback();
      return { status: 200, body: { success: true, state } };
    } catch (e: any) {
      return { status: 400, body: { error: e?.message || String(e) } };
    }
  }

  const mProxy = p.match(/^\/api\/proxies\/([^/]+)$/);
  const mProxyDefault = p.match(/^\/api\/proxies\/([^/]+)\/default$/);
  const mProxyRotate = p.match(/^\/api\/proxies\/([^/]+)\/rotate$/);
  const mProxyRotation = p.match(/^\/api\/proxies\/([^/]+)\/rotation$/);
  if (mProxyRotate && method === "POST") {
    try {
      const name = mProxyRotate[1];
      const info = getProxyRotationInfo(name);
      if (!info) return { status: 404, body: { error: "Proxy not found" } };
      if (info.to && info.to !== info.from) {
        recordProxyRotation(info.from, info.to);
        recordAudit({ category: "proxy", action: "rotate", target: info.from, actor: "api", detail: "manual rotate to " + info.to + " (" + (info.reason || "unhealthy") + ")" });
      }
      return { status: 200, body: { success: true, info } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (mProxyRotation && method === "GET") {
    const info = getProxyRotationInfo(mProxyRotation[1]);
    if (!info) return { status: 404, body: { error: "Proxy not found" } };
    return { status: 200, body: { info } };
  }
  if (mProxyDefault && method === "POST") {
    try {
      const ok = setDefaultProxyName(mProxyDefault[1]);
      recordAudit({ category: "proxy", action: "set-default", target: mProxyDefault[1], actor: "api" });
      return { status: 200, body: { success: ok, name: mProxyDefault[1] } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (mProxy && method === "GET") {
    const info = proxyInfo(mProxy[1]);
    if (!info) return { status: 404, body: { error: "Proxy not found" } };
    return { status: 200, body: info };
  }
  if (mProxy && method === "PATCH") {
    const body = await readJson(req);
    if (!body || typeof body.config !== "object") return { status: 400, body: { error: "config is required" } };
    try {
      const ok = updateProxy(mProxy[1], body.config);
      recordAudit({ category: "proxy", action: "update", target: mProxy[1], actor: "api" });
      return { status: 200, body: { success: ok, name: mProxy[1] } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (mProxy && method === "DELETE") {
    try {
      const ok = deleteProxy(mProxy[1]);
      recordAudit({ category: "proxy", action: "delete", target: mProxy[1], actor: "api" });
      return { status: 200, body: { success: ok, name: mProxy[1] } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Accounts ──
  if (method === "GET" && p === "/api/accounts") {
    return {
      status: 200,
      body: { accounts: getAccounts().map((a, index) => redactRestAccount(a, index)) },
    };
  }
  if (method === "POST" && p === "/api/accounts") {
    const body = await readJson(req);
    if (!body || typeof body.url !== "string" || !body.url.trim() || typeof body.username !== "string" || !body.username.trim()) {
      return { status: 400, body: { error: "url and username are required" } };
    }
    const deny = requireRestAccountMutation();
    if (deny) return deny;
    try {
      // addAccount appends to the array; capture the index before the save
      // because saveConfig rebuilds the config object (reference identity is lost).
      const index = getAccounts().length;
      const added = addAccount({
        platformUrl: String(body.url).trim().slice(0, 1000),
        platformUserName: String(body.username).trim().slice(0, 200),
        platformPassword: typeof body.password === "string" ? body.password : "",
        profileIds: normalizeRestProfileIds(body.profileIds),
        tags: normalizeRestTags(body.tags),
      });
      recordAudit({ category: "account", action: "add", target: added.platformUrl.slice(0, 200), actor: "api", detail: "added via API" });
      return { status: 201, body: { success: true, account: redactRestAccount(added, index) } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/accounts/bulk") {
    const body = await readJson(req);
    if (!body || typeof body.text !== "string") {
      return { status: 400, body: { error: "text is required" } };
    }
    const deny = requireRestAccountMutation();
    if (deny) return deny;
    try {
      const parsed = parseAccountsBulkText(body.text);
      if (body.createProfiles) {
        const platform = body.platform === "windows" || body.platform === "macos" || body.platform === "android"
          ? body.platform : "windows";
        const r = bulkCreateProfilesWithAccounts(parsed, { platform });
        recordAudit({ category: "account", action: "bulk-create-profiles", target: "", actor: "api", detail: "added=" + r.added + " created=" + r.created + " skipped=" + r.skipped });
        return { status: 200, body: { success: true, report: r } };
      }
      const r = bulkAddAccounts(parsed);
      recordAudit({ category: "account", action: "bulk-add", target: "", actor: "api", detail: "added=" + r.added + " skipped=" + r.skipped });
      return { status: 200, body: { success: true, report: r } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mAccountPassword = p.match(/^\/api\/accounts\/(\d+)\/password$/);
  if (mAccountPassword && method === "GET") {
    const deny = requireRestAccountSecret();
    if (deny) return deny;
    const index = Number(mAccountPassword[1]);
    const account = getAccounts()[index];
    const password = getAccountPassword(index);
    if (!account || password === null) return { status: 404, body: { error: "Account not found or no password" } };
    recordAudit({ category: "account", action: "reveal-password", target: account.platformUrl.slice(0, 200), actor: "api" });
    return { status: 200, body: { success: true, password } };
  }
  const mAccount = p.match(/^\/api\/accounts\/(\d+)$/);
  if (mAccount && method === "PATCH") {
    const body = await readJson(req);
    const deny = requireRestAccountMutation();
    if (deny) return deny;
    const index = Number(mAccount[1]);
    try {
      const patch: Partial<import("../types.js").PlatformAccount> = {};
      if (body && body.url !== undefined) patch.platformUrl = String(body.url).trim().slice(0, 1000);
      if (body && body.username !== undefined) patch.platformUserName = String(body.username).trim().slice(0, 200);
      if (body && body.password !== undefined) patch.platformPassword = String(body.password);
      if (body && body.profileIds !== undefined) patch.profileIds = normalizeRestProfileIds(body.profileIds);
      if (body && body.tags !== undefined) patch.tags = normalizeRestTags(body.tags);
      const updated = updateAccount(index, patch);
      if (!updated) return { status: 404, body: { error: "Account not found" } };
      recordAudit({ category: "account", action: "update", target: updated.platformUrl.slice(0, 200), actor: "api", detail: "updated via API" });
      return { status: 200, body: { success: true, account: redactRestAccount(updated, index) } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (mAccount && method === "DELETE") {
    const deny = requireRestAccountMutation();
    if (deny) return deny;
    const index = Number(mAccount[1]);
    const target = getAccounts()[index]?.platformUrl || "";
    try {
      const ok = deleteAccount(index);
      if (!ok) return { status: 404, body: { error: "Account not found" } };
      recordAudit({ category: "account", action: "delete", target: target.slice(0, 200), actor: "api", detail: "deleted via API" });
      return { status: 200, body: { success: true } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Automation ──
  if (method === "GET" && p === "/api/automation/rules") {
    return { status: 200, body: { rules: (getConfig() as any).automation || [] } };
  }
  if (method === "POST" && p === "/api/automation/rules") {
    const body = await readJson(req);
    if (!body || !body.trigger || !body.action) {
      return { status: 400, body: { error: "trigger and action are required" } };
    }
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    try {
      const rule = createAutomationRule(body);
      reloadSchedule();
      recordAudit({ category: "automation", action: "create", target: rule.id, actor: "api", detail: "rule created via API" });
      return { status: 201, body: { success: true, rule } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mRuleTest = p.match(/^\/api\/automation\/rules\/([^/]+)\/test-run$/);
  if (mRuleTest && method === "POST") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    try {
      return { status: 200, body: await testRunRule(decodeURIComponent(mRuleTest[1])) };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mRule = p.match(/^\/api\/automation\/rules\/([^/]+)$/);
  if (mRule && method === "PATCH") {
    const body = await readJson(req);
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const ruleId = decodeURIComponent(mRule[1]);
    try {
      const r = updateAutomationRule({ id: ruleId, ...(body || {}) } as any);
      if (!r.success) return { status: 404, body: { error: r.error || "rule not found" } };
      reloadSchedule();
      recordAudit({ category: "automation", action: "update", target: ruleId, actor: "api", detail: "rule updated via API" });
      return { status: 200, body: { success: true, rule: r.rule } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (mRule && method === "DELETE") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const ruleId = decodeURIComponent(mRule[1]);
    try {
      const ok = deleteAutomationRule(ruleId);
      if (!ok) return { status: 404, body: { error: "rule not found" } };
      reloadSchedule();
      recordAudit({ category: "automation", action: "delete", target: ruleId, actor: "api", detail: "rule deleted via API" });
      return { status: 200, body: { success: true } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Extension repository ──
  if (method === "GET" && p === "/api/extension-repository") {
    return { status: 200, body: { extensions: listExtensionRepository(url.searchParams.get("filter") || undefined) } };
  }
  if (method === "POST" && p === "/api/extension-repository") {
    const body = await readJson(req);
    if (!body || typeof body.extId !== "string" || !body.extId.trim()) {
      return { status: 400, body: { error: "extId is required" } };
    }
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    try {
      const entry = await addOrUpdateChromeStoreExtension(body.extId.trim(), { shared: body.shared, tags: normalizeRestTags(body.tags) });
      recordAudit({ category: "extension", action: "add", target: entry.id, actor: "api", detail: "added from Chrome Web Store via API" });
      return { status: 201, body: { success: true, extension: entry } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/extension-repository/local") {
    const body = await readJson(req);
    if (!body || typeof body.path !== "string" || !body.path.trim()) {
      return { status: 400, body: { error: "path is required" } };
    }
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    try {
      const entry = await installLocalExtension(body.path.trim(), { shared: body.shared, tags: normalizeRestTags(body.tags) });
      recordAudit({ category: "extension", action: "add", target: entry.id, actor: "api", detail: "installed local extension via API" });
      return { status: 201, body: { success: true, extension: entry } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mExtUpdate = p.match(/^\/api\/extension-repository\/([^/]+)\/update$/);
  if (mExtUpdate && method === "POST") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const extId = decodeURIComponent(mExtUpdate[1]);
    try {
      const entry = await updateRepositoryExtension(extId);
      recordAudit({ category: "extension", action: "update", target: extId, actor: "api", detail: "updated via API" });
      return { status: 200, body: { success: true, extension: entry } };
    } catch (e: any) {
      return notFoundStatus(e);
    }
  }
  const mExt = p.match(/^\/api\/extension-repository\/([^/]+)$/);
  if (mExt && method === "PATCH") {
    const body = await readJson(req);
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const extId = decodeURIComponent(mExt[1]);
    try {
      if (!getRepositoryExtension(extId)) return { status: 404, body: { error: "extension not found" } };
      const entry = setRepositoryExtensionMeta(extId, { shared: body?.shared, tags: normalizeRestTags(body?.tags) });
      recordAudit({ category: "extension", action: "set-meta", target: extId, actor: "api", detail: "meta updated via API" });
      return { status: 200, body: { success: true, extension: entry } };
    } catch (e: any) {
      return notFoundStatus(e);
    }
  }
  if (mExt && method === "DELETE") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const extId = decodeURIComponent(mExt[1]);
    try {
      const ok = deleteRepositoryExtension(extId);
      if (!ok) return { status: 404, body: { error: "extension not found" } };
      recordAudit({ category: "extension", action: "delete", target: extId, actor: "api", detail: "deleted via API" });
      return { status: 200, body: { success: true } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Skills ──
  if (method === "GET" && p === "/api/skills") {
    return { status: 200, body: { skills: listSkillRepository(url.searchParams.get("filter") || undefined) } };
  }
  if (method === "POST" && p === "/api/skills") {
    const body = await readJson(req);
    if (!body || typeof body.id !== "string" || !body.id.trim() || typeof body.prompt !== "string") {
      return { status: 400, body: { error: "id and prompt are required" } };
    }
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    try {
      const skill = addOrUpdateSkill(body);
      recordAudit({ category: "skill", action: "add", target: skill.id, actor: "api", detail: "skill added/updated via API" });
      return { status: 201, body: { success: true, skill } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  const mSkillInstall = p.match(/^\/api\/skills\/([^/]+)\/install$/);
  if (mSkillInstall && method === "POST") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const id = decodeURIComponent(mSkillInstall[1]);
    try {
      const skill = installSkill(id);
      recordAudit({ category: "skill", action: "install", target: id, actor: "api", detail: "skill installed via API" });
      return { status: 200, body: { success: true, skill } };
    } catch (e: any) {
      return notFoundStatus(e);
    }
  }
  const mSkill = p.match(/^\/api\/skills\/([^/]+)$/);
  if (mSkill && method === "PATCH") {
    const body = await readJson(req);
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const id = decodeURIComponent(mSkill[1]);
    try {
      const skill = setSkillMeta(id, { shared: body?.shared, enabled: body?.enabled, tags: normalizeRestTags(body?.tags) });
      recordAudit({ category: "skill", action: "set-meta", target: id, actor: "api", detail: "meta updated via API" });
      return { status: 200, body: { success: true, skill } };
    } catch (e: any) {
      return notFoundStatus(e);
    }
  }
  if (mSkill && method === "DELETE") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const id = decodeURIComponent(mSkill[1]);
    try {
      const ok = removeSkill(id);
      if (!ok) return { status: 404, body: { error: "skill not found" } };
      recordAudit({ category: "skill", action: "delete", target: id, actor: "api", detail: "skill deleted via API" });
      return { status: 200, body: { success: true } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Platform Adapters (AI Skills Hub catalog, read-only) ──
  if (method === "GET" && p === "/api/platform-adapters") {
    return { status: 200, body: { adapters: listPlatformAdapters(url.searchParams.get("filter") || undefined) } };
  }
  const mAdapter = p.match(/^\/api\/platform-adapters\/([^/]+)$/);
  if (mAdapter && method === "GET") {
    const id = decodeURIComponent(mAdapter[1]);
    const adapter = getPlatformAdapter(id);
    if (!adapter) return { status: 404, body: { error: "adapter not found" } };
    return { status: 200, body: { adapter } };
  }
  if (method === "GET" && p === "/api/platform-adapter/detect") {
    const pageUrl = url.searchParams.get("url") || "";
    const adapter = getPlatformAdapter(detectAdapter(pageUrl).id);
    return { status: 200, body: { adapter } };
  }

  // ── Engine status (Slice 77): Chromium + Firefox availability ──
  if (method === "GET" && p === "/api/engine-status") {
    return { status: 200, body: getEngineStatus() };
  }

  // ── Jobs (durable queue control) ──
  const mJobCancel = p.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (mJobCancel && method === "POST") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const jobId = decodeURIComponent(mJobCancel[1]);
    try {
      const ok = markCancelled(jobId);
      if (!ok) return { status: 404, body: { error: "job not found" } };
      cancelRunningJob(jobId);
      recordAudit({ category: "automation", action: "job-cancel", target: jobId, actor: "api", detail: "job cancelled via API" });
      return { status: 200, body: { success: true } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  // ── Runs & Jobs ──
  if (method === "GET" && p === "/api/runs") {
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    const dirId = url.searchParams.get("dirId") || undefined;
    return { status: 200, body: { runs: agentRunRecorder.listRuns({ dirId }).slice(0, limit) } };
  }
  const mRunRetry = p.match(new RegExp("^/api/runs/([^/]+)/retry$"));
  if (mRunRetry && method === "POST") {
    const r = await retryAgentRun(mRunRetry[1]);
    return { status: r.ok ? 200 : 400, body: r };
  }
  if (method === "GET" && p === "/api/jobs") {
    const status = url.searchParams.get("status") || undefined;
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    return { status: 200, body: { jobs: listJobs({ status: status as JobStatus | undefined, limit }) } };
  }
  const mJobRetry = p.match(new RegExp("^/api/jobs/([^/]+)/retry$"));
  if (mJobRetry && method === "POST") {
    const r = await retryJobRuns(mJobRetry[1]);
    return { status: r.ok ? 200 : 400, body: r };
  }

  // ── Agent (LLM config / conversations / chat / runs / DB / approvals) ──
  if (method === "GET" && p === "/api/agent/llm-config") {
    return { status: 200, body: { config: redactLlmConfig(getLlmConfig()) } };
  }
  if (method === "PUT" && p === "/api/agent/llm-config") {
    const body = await readJson(req);
    const cfg = normalizeLlmConfig(body);
    if (!cfg) {
      return { status: 400, body: { error: "apiKey (and optionally provider/apiUrl/model) are required" } };
    }
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    try {
      saveLlmConfig(cfg);
      return { status: 200, body: { success: true, config: redactLlmConfig(getLlmConfig()) } };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }

  if (method === "GET" && p === "/api/agent/conversations") {
    return { status: 200, body: { conversations: listConversations().map(conversationSummary) } };
  }
  if (method === "POST" && p === "/api/agent/conversations") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const body = await readJson(req);
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    const c = createConversation(title);
    recordAudit({ category: "llm", action: "conversation-create", target: c.id, actor: "api" });
    return { status: 201, body: { success: true, conversation: conversationSummary(c) } };
  }
  const mConv = p.match(/^\/api\/agent\/conversations\/([^/]+)$/);
  if (mConv && method === "GET") {
    const c = getConversation(decodeURIComponent(mConv[1]));
    if (!c) return { status: 404, body: { error: "Conversation not found" } };
    return { status: 200, body: { conversation: c } };
  }
  if (mConv && method === "PATCH") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const body = await readJson(req);
    if (!body || typeof body.title !== "string" || !body.title.trim()) {
      return { status: 400, body: { error: "title is required" } };
    }
    const c = renameConversation(decodeURIComponent(mConv[1]), body.title.trim().slice(0, 200));
    if (!c) return { status: 404, body: { error: "Conversation not found" } };
    recordAudit({ category: "llm", action: "conversation-rename", target: c.id, actor: "api" });
    return { status: 200, body: { success: true, conversation: conversationSummary(c) } };
  }
  if (mConv && method === "DELETE") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const id = decodeURIComponent(mConv[1]);
    const ok = deleteConversation(id);
    if (!ok) return { status: 404, body: { error: "Conversation not found" } };
    recordAudit({ category: "llm", action: "conversation-delete", target: id, actor: "api" });
    return { status: 200, body: { success: true } };
  }

  if (method === "POST" && p === "/api/agent/chat-simple") {
    const body = await readJson(req);
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return { status: 400, body: { error: "messages array is required" } };
    }
    const config = getLlmConfig() || getOrDetectLlmConfig();
    if (!config) {
      return { status: 400, body: { error: "No LLM config. Configure an API key first." } };
    }
    const msgs: LlmMessage[] = [];
    for (const m of body.messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "system") || typeof m.content !== "string") {
        return { status: 400, body: { error: "each message needs a valid role and string content" } };
      }
      msgs.push({ role: m.role, content: m.content });
    }
   try {
     const reply = await llmChat(config, msgs);
     return { status: 200, body: { reply: reply.content } };
   } catch (e: any) {
     return { status: 400, body: { error: e.message || String(e) } };
   }
 }

  // Conversation-scoped tool-calling chat over REST. Mirrors the IPC agent:chat
  // loop (persists messages, executes tools) and also records a run trace so
  // API automation gets the same observability as the UI chat-stream.
  if (method === "POST" && p === "/api/agent/chat") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const body = await readJson(req);
    if (!body || typeof body.conversationId !== "string" || !body.conversationId.trim()
      || typeof body.message !== "string" || !body.message.trim()) {
      return { status: 400, body: { error: "conversationId and message are required" } };
    }
    const conversationId = body.conversationId.trim();
    const message = body.message;
    const config = getLlmConfig() || getOrDetectLlmConfig();
    if (!config) {
      return { status: 400, body: { error: "No LLM config. Configure an API key first." } };
    }
    const conv = getConversation(conversationId);
    if (!conv) return { status: 404, body: { error: "Conversation not found" } };

    addMessage(conversationId, "user", message);
    const recentMsgs = conv.messages
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .slice(-40);
    const llmMsgs: LlmMessage[] = recentMsgs.map((m: any) => ({ role: m.role, content: m.content }));
    llmMsgs.push({ role: "user", content: message });
    const repaired = repairMessageSequence(llmMsgs);

    const timeoutMs = clampInt(String(body.timeoutMs ?? 120000), 120000, 1000, 600000);
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
        return { status: 400, body: { error: result.error, runId: run.id } };
      }
      const finalMsg = [...result.messages].reverse().find((m: any) => m.role === "assistant" && m.content);
      if (!finalMsg?.content) {
        addMessage(conversationId, "assistant", "❌ Agent did not return a final response.", []);
        return { status: 400, body: { error: "Agent did not return a final response.", runId: run.id } };
      }
      const redactedToolCalls = result.messages.flatMap((m: any) =>
        m.tool_calls?.map((tc: any) => ({ name: tc.function.name, redacted: true })) || []);
      addMessage(conversationId, "assistant", finalMsg.content, redactedToolCalls);
      return {
        status: 200,
        body: { reply: finalMsg.content, toolCalls: redactedToolCalls, runId: run.id, conversationId },
      };
    } catch (e: any) {
      const errMsg = controller.signal.aborted
        ? "Agent chat timed out after " + timeoutMs + "ms"
        : (e.message || String(e));
      agentRunRecorder.finishRun(run.id, "error", errMsg);
      addMessage(conversationId, "assistant", "❌ " + errMsg, []);
      return { status: 400, body: { error: errMsg, runId: run.id } };
    } finally {
      clearTimeout(timer);
    }
  }
  if (method === "GET" && p === "/api/agent/runs") {
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    const dirId = url.searchParams.get("dirId") || undefined;
    return { status: 200, body: { runs: agentRunRecorder.listRuns({ dirId }).slice(0, limit) } };
  }
  if (method === "DELETE" && p === "/api/agent/runs") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const deleted = agentRunRecorder.clearRuns();
    recordAudit({ category: "llm", action: "runs-clear", target: "", actor: "api", detail: "deleted=" + deleted });
    return { status: 200, body: { success: true, deleted } };
  }
  const mAgentRun = p.match(/^\/api\/agent\/runs\/([^/]+)$/);
  if (mAgentRun && method === "GET") {
    const run = agentRunRecorder.getRun(decodeURIComponent(mAgentRun[1]));
    if (!run) return { status: 404, body: { error: "Run not found" } };
    return { status: 200, body: { run } };
  }
  if (mAgentRun && method === "DELETE") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const id = decodeURIComponent(mAgentRun[1]);
    const ok = agentRunRecorder.deleteRun(id);
    if (!ok) return { status: 404, body: { error: "Run not found" } };
    recordAudit({ category: "llm", action: "run-delete", target: id, actor: "api" });
    return { status: 200, body: { success: true } };
  }

  if (method === "GET" && p === "/api/agent/db/tables") {
    return { status: 200, body: { tables: agentDbTables() } };
  }
  const mDbTable = p.match(/^\/api\/agent\/db\/([^/]+)$/);
  if (mDbTable && method === "GET") {
    try {
      const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1000000);
      return { status: 200, body: agentDbTableData(decodeURIComponent(mDbTable[1]), limit, offset) };
    } catch (e: any) {
      return { status: 400, body: { error: e.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/agent/db/query") {
    const body = await readJson(req);
    if (!body || typeof body.sql !== "string" || !body.sql.trim()) {
      return { status: 400, body: { error: "sql is required" } };
    }
    try {
      return { status: 200, body: { ok: true, ...agentDbQuery(body.sql) } };
    } catch (e: any) {
      return { status: 400, body: { ok: false, error: e.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/agent/db/exec") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const body = await readJson(req);
    if (!body || typeof body.sql !== "string" || !body.sql.trim()) {
      return { status: 400, body: { error: "sql is required" } };
    }
    const result = agentDbExecScript(body.sql);
    if (!result.ok) return { status: 400, body: result };
    recordAudit({ category: "db", action: "exec", target: "", actor: "api", detail: body.sql.trim().slice(0, 200) });
    return { status: 200, body: { success: true } };
  }

  if (method === "GET" && p === "/api/agent/approvals") {
    return { status: 200, body: { approvals: listPendingApprovals() } };
  }
  const mApprovalResolve = p.match(/^\/api\/agent\/approvals\/([^/]+)\/resolve$/);
  if (mApprovalResolve && method === "POST") {
    const deny = requireRestSettingsMutation();
    if (deny) return deny;
    const body = await readJson(req);
    const decision = body?.decision;
    if (decision !== "once" && decision !== "always" && decision !== "deny") {
      return { status: 400, body: { error: "decision must be once, always or deny" } };
    }
    const id = decodeURIComponent(mApprovalResolve[1]);
    const ok = resolveApproval(id, decision);
    if (!ok) return { status: 404, body: { error: "Approval request not found" } };
    recordAudit({ category: "approval", action: "resolve", target: id, actor: "api", detail: "decision=" + decision });
    return { status: 200, body: { success: true } };
  }

  // ── Sync (team workspace) ──
  if (method === "GET" && p === "/api/sync/status") {
    return { status: 200, body: syncService.getStatus() };
  }
  if (method === "POST" && p === "/api/sync/push") {
    const opts = await readJson(req).catch(() => null);
    try {
      const r = await syncService.push(undefined, Boolean(opts?.force));
      return { status: r.success ? 200 : 400, body: r };
    } catch (e: any) {
      return { status: 500, body: { success: false, message: e.message || String(e) } };
    }
  }
  if (method === "POST" && p === "/api/sync/pull") {
    const opts = await readJson(req).catch(() => null);
    try {
      const strategy = opts?.strategy === "remote" || opts?.strategy === "newest" ? opts.strategy : "local";
      const resolutions: Record<string, "local" | "remote" | "newest"> = {};
      for (const [key, value] of Object.entries(opts?.resolutions || {})) {
        if (value === "local" || value === "remote" || value === "newest") resolutions[key] = value;
      }
      const r = await syncService.pull(undefined, { strategy, resolutions });
      return { status: r.success ? 200 : 400, body: { ...r, strategy } };
    } catch (e: any) {
      return { status: 500, body: { success: false, message: e.message || String(e) } };
    }
  }

  // ── Audit ──
  if (method === "GET" && p === "/api/audit") {
    const limit = clampInt(url.searchParams.get("limit"), 200, 1, 2000);
    return {
      status: 200,
      body: {
        audit: listAudit(limit, {
          category: url.searchParams.get("category") || undefined,
          target: url.searchParams.get("target") || undefined,
        }),
      },
    };
  }
  if (method === "DELETE" && p === "/api/audit") {
    clearAudit();
    recordAudit({ category: "settings", action: "audit.clear", actor: "api" });
    return { status: 200, body: { success: true } };
  }

  return { status: 404, body: { error: "Not found" } };
}

// ═══════════════════════════════════════════════════════════════
// HTTP Server lifecycle
// ═══════════════════════════════════════════════════════════════

export function startRestApiServer(): { port: number; ready: Promise<void> } {
  if (server) return { port: apiPort, ready: serverListening ? Promise.resolve() : waitForApiReady() };

  apiPort = configuredApiPort();

  let markReady: () => void;
  let markFailed: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; markFailed = reject; });

  server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Browser-Token, X-Cloak-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (isRateLimited(loopbackRateKey(req))) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    if (!isTrustedOrigin(req.headers.origin, req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1:" + apiPort);
    const openPath = (url.pathname === "/health" || url.pathname === "/openapi.json") && req.method === "GET";
    if (!openPath && !isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const { status, body } = await handleRequest(req, url);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    } catch (e: any) {
      const status = e instanceof HttpError || (e && typeof e.status === "number") ? e.status : 500;
      if (status >= 500) console.error("[api] request failed:", url.pathname, e);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || "Internal error" }));
    }
  });

  let fallbackAttempted = false;
  const onListening = () => {
    const address = server?.address();
    if (address && typeof address !== "string") apiPort = address.port;
    serverListening = true;
    markReady();
    console.log("[api] REST API listening on http://127.0.0.1:" + apiPort);
  };
  server.on("error", (err: any) => {
    serverListening = false;
    if (err.code === "EADDRINUSE" && !fallbackAttempted && apiPort !== 0 && server) {
      fallbackAttempted = true;
      console.warn("[api] Port " + apiPort + " is in use; retrying on an ephemeral loopback port.");
      apiPort = 0;
      server.listen(0, "127.0.0.1", onListening);
      return;
    }
    server = null;
    markFailed(err instanceof Error ? err : new Error(String(err)));
    console.error("[api] Server error:", err.message);
  });
  server.listen(apiPort, "127.0.0.1", onListening);

  return { port: apiPort, ready };
}

export function stopRestApiServer(): Promise<void> {
  if (!server) return Promise.resolve();
  const closing = server;
  serverListening = false;
  server = null;
  return new Promise((resolve, reject) => {
    closing.close((err: NodeJS.ErrnoException | undefined) => {
      if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      console.log("[api] REST API server stopped");
      resolve();
    });
  });
}

export function getRestApiPort(): number {
  return apiPort;
}

export function getRestApiToken(): string {
  return API_TOKEN;
}

export function isRestApiServerRunning(): boolean {
  return serverListening;
}

async function waitForApiReady(): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!serverListening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!serverListening) throw new Error("REST API server did not start listening in time");
}

// ═══════════════════════════════════════════════════════════════
// OpenAPI 3.0 document
// ═══════════════════════════════════════════════════════════════

function buildOpenApi(): any {
  const dirIdParam = {
    name: "dirId", in: "path", required: true,
    schema: { type: "string" }, description: "Profile directory ID (ab_…; legacy cb_… accepted)",
  };
  const nameParam = {
    name: "name", in: "path", required: true,
    schema: { type: "string" }, description: "Proxy name",
  };
  const extIdParam = {
    name: "extId", in: "path", required: true,
    schema: { type: "string" }, description: "32-char Chrome extension ID",
  };
  const ok = (desc: string) => ({ "200": { description: desc } });
  const created = (desc: string) => ({ "201": { description: desc } });
  return {
    openapi: "3.0.3",
    info: {
      title: PRODUCT_NAME + " Local REST API",
      version: API_VERSION,
      description: "Loopback control API for managed Chromium profiles, proxies, accounts, extensions, automation rules, runs, jobs and audit. Bearer-token auth (AGENT_BROWSER_API_TOKEN); /health and /openapi.json are open.",
    },
    servers: [{ url: "http://127.0.0.1:" + apiPort, description: "Local loopback" }],
    paths: {
      "/health": { get: { summary: "Liveness probe", responses: ok("Service status") } },
      "/openapi.json": { get: { summary: "OpenAPI document", responses: ok("OpenAPI 3.0 spec") } },
      "/version": { get: { summary: "Product + runtime Chromium version", responses: ok("Version info") } },
      "/api/server/idle": {
        get: { summary: "Idle auto-stop policy + per-profile idle times", responses: ok("Idle policy") },
      },
      "/api/profiles": {
        get: { summary: "List managed Chromium profiles", responses: ok("Profile list") },
        post: {
          summary: "Create a profile",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, platform: { type: "string" }, locale: { type: "string" }, timezone: { type: "string" }, fingerprintSeed: { type: "integer" }, proxyMode: { type: "string", enum: ["none", "default", "named"] }, proxyName: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: created("Created profile dirId"),
        },
      },
      "/api/profiles/{dirId}": {
        parameters: [dirIdParam],
        get: { summary: "Profile detail (fingerprint meta, resolved proxy, status)", responses: ok("Profile detail") },
        delete: { summary: "Delete a stopped profile", responses: ok("Deletion result") },
      },
      "/api/profiles/{dirId}/status": {
        parameters: [dirIdParam],
        get: { summary: "Running status / CDP port", responses: ok("Status") },
      },
      "/api/profiles/{dirId}/drift": {
        parameters: [dirIdParam],
        get: { summary: "Read-only fingerprint drift check vs stored baseline", responses: ok("Drift check") },
      },
      "/api/profiles/{dirId}/env-risk": {
        parameters: [dirIdParam],
        get: { summary: "Host environment risk report (DNS resolvers / CN fonts / proxy DNS / rAF)", responses: ok("Environment risk") },
      },
      "/api/profiles/{dirId}/launch": {
        parameters: [dirIdParam],
        post: { summary: "Launch the profile's managed Chromium", responses: ok("Launch result") },
      },
      "/api/profiles/{dirId}/stop": {
        parameters: [dirIdParam],
        post: { summary: "Stop the profile's managed Chromium", responses: ok("Stop result") },
      },
      "/api/profiles/{dirId}/drm": {
        parameters: [dirIdParam],
        post: {
          summary: "Enable or disable Widevine/DRM for a profile",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
          responses: ok("Profile DRM state"),
        },
      },
      "/api/profiles/{dirId}/extensions": {
        parameters: [dirIdParam],
        get: { summary: "List extension repository + per-profile enabled state", responses: ok("Extension list") },
      },
      "/api/profiles/{dirId}/extensions/{extId}/install": {
        parameters: [dirIdParam, extIdParam],
        post: { summary: "Download + enable a Chrome Web Store extension", responses: ok("Install result") },
      },
      "/api/profiles/{dirId}/extensions/{extId}": {
        parameters: [dirIdParam, extIdParam],
        delete: { summary: "Disable an extension for the profile", responses: ok("Disable result") },
      },
      "/api/profiles/import": {
        post: {
          summary: "Import a profile backup ZIP into a fresh profile (portable archive)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["zipPath"], properties: { zipPath: { type: "string", description: "Absolute path to a profile backup ZIP produced by the export endpoint" } } } } } },
          responses: ok("Import result with new dirId"),
        },
      },
      "/api/profiles/import-batch": {
        post: {
          summary: "Import several profile backup ZIPs at once (per-archive success/failure report)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["zipPaths"], properties: { zipPaths: { type: "array", items: { type: "string" }, description: "Absolute paths to profile backup ZIPs" } } } } } },
          responses: ok("Batch import report"),
        },
      },
      "/api/profiles/export": {
        post: {
          summary: "Export several stopped profiles into one directory (running profiles are skipped)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["dirIds"], properties: { dirIds: { type: "array", items: { type: "string" }, description: "Profile dirIds to export" }, destDir: { type: "string", description: "Optional destination directory; defaults to <appData>/backups" } } } } } },
          responses: ok("Batch export report"),
        },
      },
      "/api/profiles/{dirId}/export": {
        parameters: [dirIdParam],
        post: {
          summary: "Export a stopped profile into a portable ZIP backup",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { destPath: { type: "string", description: "Optional absolute destination path; defaults to <appData>/backups/profile-<dirId>-<timestamp>.zip" } } } } } },
          responses: ok("Export result with filePath"),
        },
      },
      "/api/proxies": {
        get: { summary: "List configured proxies", responses: ok("Proxy list") },
        post: {
          summary: "Add a proxy",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["name", "config"], properties: { name: { type: "string" }, config: { type: "object", required: ["type", "host", "port"], properties: { type: { type: "string", enum: ["http", "socks5", "socks5h"] }, host: { type: "string" }, port: { type: "integer" }, username: { type: "string" }, password: { type: "string" }, bypassList: { type: "array", items: { type: "string" } }, fallbacks: { type: "array", items: { type: "string" } } } } } } } } },
          responses: created("Proxy added"),
        },
      },
      "/api/proxies/health": { get: { summary: "Proxy health scores / risk / bindings / suggestions", responses: ok("Health entries + summary") } },
      "/api/proxies/import": {
        post: {
          summary: "Bulk import proxies from URI lines or name,type,host,port,username,password CSV",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", description: "Multi-line proxy list" }, replace: { type: "boolean", description: "Replace same-name proxies instead of auto-renaming" } } } } } },
          responses: ok("Import report (imported / skipped / failed)"),
        },
      },
      "/api/proxies/export": { get: { summary: "Export all proxies as a CSV document (passwords included for migration)", responses: ok("CSV text") } },
      "/api/drm/status": { get: { summary: "Widevine/DRM availability + per-profile DRM state", responses: ok("DRM status") } },
      "/api/drm/cdm-path": {
        post: {
          summary: "Override (or clear, with null) the Widevine CDM path",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { cdmPath: { type: "string", nullable: true } } } } } },
          responses: ok("Configured CDM path"),
        },
      },
      "/api/drm/ensure": { post: { summary: "Stage the managed Widevine CDM copy", responses: ok("Staged status") } },
      "/api/team": { get: { summary: "Team workspace RBAC status (members, roles, enforcement)", responses: ok("Team status") } },
      "/api/team/init": { post: { summary: "Initialize the team workspace (local device becomes owner)", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } }, responses: ok("Team manifest") } },
      "/api/team/members": { post: { summary: "Add a workspace member", requestBody: { content: { "application/json": { schema: { type: "object", required: ["deviceId", "role"], properties: { deviceId: { type: "string" }, name: { type: "string" }, role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } } } } } }, responses: ok("Updated team manifest") } },
      "/api/team/members/{deviceId}": { parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }], delete: { summary: "Remove a workspace member", responses: ok("Updated team manifest") } },
      "/api/team/members/{deviceId}/role": { parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }], put: { summary: "Change a member role", requestBody: { content: { "application/json": { schema: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } } } } } }, responses: ok("Updated team manifest") } },
      "/api/team/rename": { post: { summary: "Rename the workspace (owner only)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } }, responses: ok("Updated team manifest") } },
      "/api/updates/status": { get: { summary: "Release store status (active/pinned/installed/history)", responses: ok("Update state") } },
      "/api/updates/check": { post: { summary: "Check the update manifest for newer releases", requestBody: { content: { "application/json": { schema: { type: "object", properties: { manifestUrl: { type: "string", description: "Optional manifest URL/path override" } } } } } }, responses: ok("Available releases") } },
      "/api/updates/install": { post: { summary: "Download + verify + stage a release payload", requestBody: { content: { "application/json": { schema: { type: "object", required: ["version"], properties: { version: { type: "string" } } } } } }, responses: ok("Updated state") } },
      "/api/updates/activate": { post: { summary: "Pin a staged release as active for next launch", requestBody: { content: { "application/json": { schema: { type: "object", required: ["version"], properties: { version: { type: "string" } } } } } }, responses: ok("Updated state") } },
      "/api/updates/rollback": { post: { summary: "Roll back to the previous known-good release", responses: ok("Updated state") } },
      "/api/proxies/{name}": {
        parameters: [nameParam],
        get: { summary: "Proxy detail", responses: ok("Proxy info") },
        patch: {
          summary: "Update a proxy",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["config"], properties: { config: { type: "object" } } } } } },
          responses: ok("Update result"),
        },
        delete: { summary: "Delete a proxy", responses: ok("Delete result") },
      },
      "/api/proxies/{name}/default": {
        parameters: [nameParam],
        post: { summary: "Set the default proxy", responses: ok("Set-default result") },
      },
      "/api/proxies/{name}/rotate": {
        parameters: [nameParam],
        post: { summary: "Manually rotate to the first healthy fallback", responses: ok("Rotation info") },
      },
      "/api/proxies/{name}/rotation": {
        parameters: [nameParam],
        get: { summary: "Read-only rotation status", responses: ok("Rotation info") },
      },
      "/api/accounts": {
        get: { summary: "List stored accounts (index, url, username, tags, profileIds, hasPassword; never the password)", responses: ok("Account list") },
        post: {
          summary: "Add an account (password encrypted at rest)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["url", "username"], properties: { url: { type: "string" }, username: { type: "string" }, password: { type: "string" }, profileIds: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: created("Account added with index"),
        },
      },
      "/api/accounts/bulk": {
        post: {
          summary: "Bulk import accounts from pasted lines (url,username,password,tags); createProfiles=true also creates a bound profile per account",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, createProfiles: { type: "boolean" }, platform: { type: "string", enum: ["windows", "macos", "android"] } } } } } },
          responses: ok("Import report (added / skipped / errors; +created when createProfiles)"),
        },
      },
      "/api/accounts/{index}": {
        parameters: [{ name: "index", in: "path", required: true, schema: { type: "integer" } }],
        patch: {
          summary: "Update an account (partial; empty/omitted password keeps the stored one)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" }, username: { type: "string" }, password: { type: "string" }, profileIds: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: ok("Update result with account"),
        },
        delete: { summary: "Delete an account", responses: ok("Delete result") },
      },
      "/api/accounts/{index}/password": {
        parameters: [{ name: "index", in: "path", required: true, schema: { type: "integer" } }],
        get: { summary: "Reveal a stored account password (member+ when team enabled)", responses: ok("Revealed password") },
      },
      "/api/automation/rules": {
        get: { summary: "List automation rules", responses: ok("Rule list") },
        post: {
          summary: "Create an automation rule (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["trigger", "action"], properties: { name: { type: "string" }, enabled: { type: "boolean" }, trigger: { type: "object" }, action: { type: "object" }, runTimeoutMs: { type: "integer" }, maxRetries: { type: "integer" } } } } } },
          responses: ok("Created rule"),
        },
      },
      "/api/automation/rules/{ruleId}": {
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          summary: "Update an automation rule (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, enabled: { type: "boolean" }, trigger: { type: "object" }, action: { type: "object" }, runTimeoutMs: { type: "integer" }, maxRetries: { type: "integer" } } } } } },
          responses: ok("Updated rule"),
        },
        delete: { summary: "Delete an automation rule (member+ when team enabled)", responses: ok("Delete result") },
      },
      "/api/automation/rules/{ruleId}/test-run": {
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Run an automation rule once immediately (member+ when team enabled)", responses: ok("Test-run result") },
      },
      "/api/runs": { get: { summary: "List recent agent runs (limit/dirId query params)", responses: ok("Run list") } },
      "/api/runs/{id}/retry": {
        post: {
          summary: "Retry a failed automation run on its profile (re-runs the rule's agent task)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("Retry result with new runId"),
        },
      },
      "/api/jobs": { get: { summary: "List automation jobs (status/limit query params)", responses: ok("Job list") } },
      "/api/jobs/{jobId}/retry": {
        post: {
          summary: "Retry every failed profile of a batch job",
          parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("Batch retry summary (attempted/succeeded/failed)"),
        },
      },
      "/api/jobs/{jobId}/cancel": {
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Cancel a queued/running job (member+ when team enabled)", responses: ok("Cancel result") },
      },
      "/api/extension-repository": {
        get: { summary: "List the shared extension repository (filter query param)", responses: ok("Extension list") },
        post: {
          summary: "Add a Chrome Web Store extension to the repository (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["extId"], properties: { extId: { type: "string" }, shared: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: ok("Added extension"),
        },
      },
      "/api/extension-repository/local": {
        post: {
          summary: "Install a local CRX/ZIP/unpacked extension into the repository (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Local CRX/ZIP file or unpacked directory" }, shared: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: ok("Installed extension"),
        },
      },
      "/api/extension-repository/{extId}": {
        parameters: [{ name: "extId", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          summary: "Set extension repository metadata (shared/tags) (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { shared: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: ok("Updated extension"),
        },
        delete: { summary: "Remove an extension from the repository (member+ when team enabled)", responses: ok("Delete result") },
      },
      "/api/extension-repository/{extId}/update": {
        parameters: [{ name: "extId", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Refresh a repository extension from its source (member+ when team enabled)", responses: ok("Updated extension") },
      },
      "/api/skills": {
        get: { summary: "List skills (filter query param)", responses: ok("Skill list") },
        post: {
          summary: "Add or update a skill (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["id", "prompt"], properties: { id: { type: "string" }, name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, version: { type: "string" }, source: { type: "string" }, tools: { type: "array", items: { type: "string" } }, prompt: { type: "string" }, shared: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: ok("Saved skill"),
        },
      },
      "/api/skills/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          summary: "Set skill metadata (shared/enabled/tags) (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { shared: { type: "boolean" }, enabled: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } } } } },
          responses: ok("Updated skill"),
        },
        delete: { summary: "Remove a skill (member+ when team enabled)", responses: ok("Delete result") },
      },
      "/api/skills/{id}/install": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Install (enable) a skill (member+ when team enabled)", responses: ok("Installed skill") },
      },
      "/api/platform-adapters": {
        get: {
          summary: "List the AI Skills Hub platform adapter catalog (filter by id/name/category/region/preset/capability)",
          parameters: [{ name: "filter", in: "query", schema: { type: "string" } }],
          responses: ok("Platform adapter catalog (lean summaries)"),
        },
      },
      "/api/platform-adapters/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get one full platform adapter (with loginCheck + selectors)", responses: ok("Platform adapter detail") },
      },
      "/api/platform-adapter/detect": {
        get: {
          summary: "Detect the matching platform adapter for a URL",
          parameters: [{ name: "url", in: "query", required: true, schema: { type: "string" } }],
          responses: ok("Matched platform adapter"),
        },
      },
      "/api/engine-status": {
        get: { summary: "Report both browser engines (managed Chromium + Firefox availability)", responses: ok("Engine status") },
      },
      "/api/agent/llm-config": {
        get: { summary: "Read the saved LLM config (API key redacted; hasApiKey boolean)", responses: ok("LLM config") },
        put: {
          summary: "Save the LLM config (member+ when team enabled); API key encrypted at rest",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["apiKey"], properties: { provider: { type: "string", enum: ["openai", "claude", "custom"] }, apiKey: { type: "string" }, apiUrl: { type: "string" }, model: { type: "string" } } } } } },
          responses: ok("Saved config (redacted)"),
        },
      },
      "/api/agent/conversations": {
        get: { summary: "List agent conversations (summaries, newest first)", responses: ok("Conversation list") },
        post: {
          summary: "Create a conversation (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } } } } } },
          responses: created("Created conversation"),
        },
      },
      "/api/agent/conversations/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get a conversation with its full message history", responses: ok("Conversation") },
        patch: {
          summary: "Rename a conversation (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } } } },
          responses: ok("Renamed conversation"),
        },
        delete: { summary: "Delete a conversation (member+ when team enabled)", responses: ok("Delete result") },
      },
     "/api/agent/chat-simple": {
       post: {
         summary: "One-shot chat without tools (requires a saved LLM config)",
         requestBody: { content: { "application/json": { schema: { type: "object", required: ["messages"], properties: { messages: { type: "array", items: { type: "object", required: ["role", "content"], properties: { role: { type: "string", enum: ["system", "user", "assistant"] }, content: { type: "string" } } } } } } } } },
         responses: ok("Reply text"),
       },
     },
      "/api/agent/chat": {
        post: {
          summary: "Conversation-scoped tool-calling chat (member+ when team enabled); persists to the conversation and records a run trace",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["conversationId", "message"], properties: { conversationId: { type: "string" }, message: { type: "string" }, timeoutMs: { type: "integer", description: "Abort timeout in ms (default 120000)" } } } } } },
          responses: ok("Reply, redacted tool calls and runId"),
        },
      },
      "/api/agent/runs": {
        get: { summary: "List agent run traces (limit/dirId query params)", responses: ok("Run list") },
        delete: { summary: "Clear all run traces (member+ when team enabled)", responses: ok("Clear result with deleted count") },
      },
      "/api/agent/runs/{runId}": {
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get one run trace with steps", responses: ok("Run detail") },
        delete: { summary: "Delete one run trace (member+ when team enabled)", responses: ok("Delete result") },
      },
      "/api/agent/db/tables": {
        get: { summary: "List agent SQLite store tables with row counts", responses: ok("Table list") },
      },
      "/api/agent/db/{table}": {
        parameters: [{ name: "table", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Read table rows (limit/offset query params; capped at 1000)", responses: ok("Table data") },
      },
      "/api/agent/db/query": {
        post: {
          summary: "Run a read-only SQL query (SELECT/WITH/PRAGMA/EXPLAIN only)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["sql"], properties: { sql: { type: "string" } } } } } },
          responses: ok("Query rows (capped at 1000)"),
        },
      },
      "/api/agent/db/exec": {
        post: {
          summary: "Run a write SQL script (member+ when team enabled; INSERT/UPDATE/DELETE/DDL)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["sql"], properties: { sql: { type: "string" } } } } } },
          responses: ok("Exec result"),
        },
      },
      "/api/agent/approvals": {
        get: { summary: "List pending risky-operation approval requests", responses: ok("Approval list") },
      },
      "/api/agent/approvals/{id}/resolve": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: {
          summary: "Resolve a pending approval (member+ when team enabled)",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["once", "always", "deny"] } } } } } },
          responses: ok("Resolve result"),
        },
      },
      "/api/sync/status": { get: { summary: "Sync configuration / connectivity status", responses: ok("Sync status") } },
      "/api/sync/push": {
        post: {
          summary: "Push local config + artifacts to the team workspace",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { force: { type: "boolean", description: "Force push past remote profile locks" } } } } } },
          responses: ok("Push result"),
        },
      },
      "/api/sync/pull": {
        post: {
          summary: "Pull + merge remote config (global or per-entry conflict strategy)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { strategy: { type: "string", enum: ["local", "remote", "newest"], default: "local", description: "Default conflict resolution for id-keyed entries (profiles/proxies/accounts). local = keep local, remote = adopt remote, newest = adopt newer updatedAt/syncedAt." }, resolutions: { type: "object", additionalProperties: { type: "string", enum: ["local", "remote", "newest"] }, description: "Per-entry overrides keyed as <section>:<id>, e.g. profiles:ab_xyz, proxies:default, accounts:user @ https://a.com. Wins over the global strategy for that entry." } } } } } },
          responses: ok("Pull result with merge summary"),
        },
      },
      "/api/audit": {
        get: { summary: "List audit entries (limit/category/target query params)", responses: ok("Audit list") },
        delete: { summary: "Clear the audit log", responses: ok("Clear result") },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        xToken: { type: "apiKey", in: "header", name: "X-Agent-Browser-Token" },
      },
    },
    security: [{ bearerAuth: [] }, { xToken: [] }],
  };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sanitizeProfileOpts(opts: any): any {
  const keys = [
    "engine", "fingerprintMode", "browserVersion", "allowThirdPartyCookies", "fingerprintSeed",
    "platform", "timezone", "locale", "webrtcMode", "webrtcIp", "geolocationMode",
    "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy", "gpuVendor",
    "gpuRenderer", "hardwareConcurrency", "deviceMemory", "screenWidth", "screenHeight",
    "windowTitlePrefix",
    "appUrl",
    "storageQuota", "taskbarHeight", "fontsDir", "proxyMode", "proxyName", "tags",
  ];
  const out: any = { name: String(opts.name).trim() };
  for (const k of keys) if (opts[k] !== undefined) out[k] = opts[k];
  return out;
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = value === null ? NaN : Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function defaultBackupPath(dirId: string): string {
  const backupsDir = path.join(getAppDataDir(), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(backupsDir, "profile-" + dirId + "-" + stamp + ".zip");
}

function defaultBackupPathForBatch(): string {
  const backupsDir = path.join(getAppDataDir(), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  return backupsDir;
}

function assertProfileExists(dirId: string): void {
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
    throw new Error("Invalid extension ID: " + JSON.stringify(extId));
  }
}


const RATE_MAX = 120;
const RATE_WINDOW_MS = 60_000;
const rateMap = new Map<string, number[]>();
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateMap.set(key, arr);
  if (arr.length > RATE_MAX) return true;
  if (rateMap.size > 200) {
    for (const [k, v] of rateMap) if (!v.length || now - Math.max(...v) > RATE_WINDOW_MS) rateMap.delete(k);
  }
  return false;
}
function loopbackRateKey(req: import("node:http").IncomingMessage): string {
  const ip = (req.socket && (req.socket as any).remoteAddress) || "127.0.0.1";
  // Cheap path normalization to avoid unbounded key explosion while keeping burst fairness.
  try { return ip + ":" + new URL(req.url || "/", "http://127.0.0.1").pathname; } catch { return ip; }
}

function isAuthorized(req: http.IncomingMessage): boolean {
  return isAuthorizedShared(req, API_TOKEN);
}

function isTrustedOrigin(origin: string | undefined, req?: http.IncomingMessage): boolean {
  if (!origin) {
    if (!req) return true;
    const host = String(req.headers.host || "").split(":")[0].toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }
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

async function readJson(req: http.IncomingMessage): Promise<any> {
  // Shared streaming body reader: enforces the 2 MiB cap while chunks arrive
  // (not after full buffering) and answers invalid JSON with 400 instead of
  // silently treating it as an empty object.
  return readJsonShared(req, { maxBytes: 2 * 1024 * 1024 });
}
