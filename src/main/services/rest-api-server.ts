// ── Agent Browser Studio Local REST API ──
// Loopback JSON REST server exposing the same service layer as the MCP server,
// plus an OpenAPI 3.0 document for SDK/tooling generation. Token-auth'd
// (AGENT_BROWSER_API_TOKEN / CLOAK_API_TOKEN, or a generated local token).
// Open endpoints: GET /health and GET /openapi.json (loopback only).

import * as http from "node:http";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getConfig, getProxyList, addProxy, deleteProxy, updateProxy,
  setDefaultProxyName, getProxyRotationInfo, getProfileMeta,
  resolveProfileProxy, saveConfig, getAppDataDir,
} from "./config-manager.js";
import { listProxyHealth, proxyHealthSummary, recordProxyRotation } from "./proxy-health.js";
import { getAccounts } from "./local-agent.js";
import { listAudit, clearAudit, recordAudit } from "./audit-log.js";
import { listJobs, type JobStatus } from "./job-store.js";
import { agentRunRecorder } from "./agent-run-trace.js";
import { listExtensionRepository, addOrUpdateChromeStoreExtension } from "./extension-repository.js";
import {
  listBrowserProfiles, launchBrowser, stopBrowser, statusBrowser, checkFingerprintDrift,
  createBrowserProfile, deleteBrowserProfile,
  findRuntimeChromiumBinary, getRuntimeChromiumVersion,
} from "./browser-manager.js";
import { validateDirId } from "./utils.js";
import { checkEnvironmentRisk, checkEnvironmentRiskRuntime } from "./environment-risk.js";
import { exportProfileArchive, importProfileArchive, exportProfileArchives, importProfileArchives } from "./profile-archive.js";
import { syncService } from "./sync-service.js";
import { retryAgentRun, retryJobRuns } from "./automation.js";
import { PRODUCT_NAME, PRODUCT_SLUG } from "../branding.js";

const API_VERSION = "1.0.0";
let server: http.Server | null = null;
let serverListening = false;
const API_DEFAULT_PORT = 26582;
let apiPort = configuredApiPort();
const API_TOKEN = process.env.AGENT_BROWSER_API_TOKEN
  || process.env.CLOAK_API_TOKEN
  || createLocalToken();

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
    browser: "chromium",
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

async function handleRequest(req: http.IncomingMessage, url: URL): Promise<JsonResponse> {
  const method = req.method || "GET";
  const p = url.pathname || "/";

  if (method === "GET" && p === "/health") {
    return { status: 200, body: { status: "ok", service: PRODUCT_SLUG + "-api", port: apiPort } };
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
      const r = await launchBrowser(dirId);
      recordAudit({ category: "profile", action: "launch", target: dirId, actor: "api" });
      return { status: 200, body: { success: true, dirId, pid: r.pid, cdpPort: r.cdpPort, driftCheck: r.driftCheck, envCheck: r.envCheck } };
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
      if (st.running && st.cdpPort) return { status: 200, body: await checkEnvironmentRiskRuntime(profile, st.cdpPort) };
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
    try {
      const r = importProfileArchive(body.zipPath);
      recordAudit({ category: "profile", action: "import", target: r.dirId, actor: "api", detail: "imported " + body.zipPath });
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
    const report = importProfileArchives(body.zipPaths.filter((z: any) => typeof z === "string"));
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
      const destDir = typeof body?.destDir === "string" && body.destDir.trim() ? body.destDir : defaultBackupPathForBatch();
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
      const destPath = typeof body?.destPath === "string" && body.destPath.trim() ? body.destPath : defaultBackupPath(dirId);
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
      body: { accounts: getAccounts().map((a) => ({ url: a.platformUrl, username: a.platformUserName, tags: a.tags })) },
    };
  }

  // ── Automation ──
  if (method === "GET" && p === "/api/automation/rules") {
    return { status: 200, body: { rules: (getConfig() as any).automation || [] } };
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
      const r = await syncService.pull(undefined, strategy);
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
    if (!isTrustedOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Browser-Token, X-Cloak-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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
      res.writeHead(500, { "Content-Type": "application/json" });
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
      "/api/accounts": { get: { summary: "List stored account usernames + platform URLs", responses: ok("Account list") } },
      "/api/automation/rules": { get: { summary: "List automation rules", responses: ok("Rule list") } },
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
          summary: "Pull + merge remote config (conflict strategy: local/remote/newest)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { strategy: { type: "string", enum: ["local", "remote", "newest"], default: "local", description: "How to resolve conflicting id-keyed entries (profiles/proxies/accounts). local = keep local, remote = adopt remote, newest = adopt newer updatedAt/syncedAt." } } } } } },
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
    "fingerprintMode", "browserVersion", "allowThirdPartyCookies", "fingerprintSeed",
    "platform", "timezone", "locale", "webrtcMode", "webrtcIp", "geolocationMode",
    "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy", "gpuVendor",
    "gpuRenderer", "hardwareConcurrency", "deviceMemory", "screenWidth", "screenHeight",
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

function isAuthorized(req: http.IncomingMessage): boolean {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
  const headerToken = req.headers["x-agent-browser-token"] ?? req.headers["x-cloak-token"];
  const token = bearer || (Array.isArray(headerToken) ? headerToken[0] : headerToken);
  return token === API_TOKEN;
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

async function readJson(req: http.IncomingMessage): Promise<any> {
  let data = "";
  for await (const chunk of req) data += chunk.toString();
  if (!data.trim()) return {};
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}
