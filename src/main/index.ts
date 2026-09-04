import { app, BrowserWindow, dialog, session, shell } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerProfileHandlers } from "./ipc/profile.js";
import { registerProxyHandlers } from "./ipc/proxy.js";
import { registerDrmHandlers } from "./ipc/drm.js";
import { registerStorageHandlers } from "./ipc/storage.js";
import { registerSyncHandlers } from "./ipc/sync.js";
import { registerAppHandlers } from "./ipc/app.js";
import { registerDetectHandlers } from "./ipc/detect.js";
import { registerSettingsHandlers } from "./ipc/settings.js";
import { registerAgentHandlers } from "./ipc/agent.js";
import { registerMcpHandlers } from "./ipc/mcp.js";
import { registerApiHandlers } from "./ipc/api.js";
import { registerBrowserHandlers } from "./ipc/browser.js";
import { registerWebRtcHandlers } from "./ipc/webrtc.js";
import { registerTeamHandlers } from "./ipc/team.js";
import { registerAutomationHandlers } from "./ipc/automation.js";
import { registerAuditHandlers } from "./ipc/audit.js";
import { registerDataHandlers } from "./ipc/data.js";
import { registerUpdateHandlers } from "./ipc/updates.js";
import { registerObservabilityHandlers } from "./ipc/observability.js";
import { configureObservability, logInfo, logWarn, logError } from "./services/observability.js";
import { startScheduler } from "./services/automation.js";
import { isHeadlessMode } from "./services/server-mode.js";
import { startMcpServer, stopMcpServer } from "./services/mcp-server.js";
import { startRestApiServer, stopRestApiServer } from "./services/rest-api-server.js";
import { stopAllBrowserProfiles, setIdlePolicyTimeoutMs, sweepIdleProfiles, getIdlePolicyTimeoutMs, purgeExpiredTrash } from "./services/browser-manager.js";
import { migrateSecrets, getAppDataDir } from "./services/config-manager.js";
import { noteAppStarted, markAppHealthy, noteAppCrashed } from "./services/update-manager.js";
import { createTray, destroyTray, refreshTrayMenu } from "./services/tray-manager.js";
import { UI_STORAGE_PARTITION, migrateLegacyRendererStorage } from "./services/renderer-storage.js";
import {
  APP_DATA_DIR_NAME,
  CHROMIUM_CACHE_DIR_NAME,
  LEGACY_CHROMIUM_CACHE_DIR_NAME,
  LEGACY_PRODUCT_NAME,
  PRODUCT_NAME,
  configureProductIdentity,
} from "./branding.js";
import {
  migrateLegacyChromiumCache,
  migrateLegacyUserData,
} from "./services/legacy-data-migration.js";
import {
  initializeSecretStorage,
  planSecretStorage,
  type SecretStoragePlan,
} from "./services/secrets.js";

// ── ESM dirname equivalent ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Establish the new product identity before any lazy user-data path resolves.
// Explicit --user-data-dir runs (tests and diagnostics) stay isolated and do
// not import real user data.
const productIdentity = configureProductIdentity(app);
let legacyMigrationError: Error | null = null;
let secretStoragePlan: SecretStoragePlan | null = null;
let secretStoragePlanError: Error | null = null;
try {
  secretStoragePlan = planSecretStorage({
    userDataDir: productIdentity.userDataDir,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
  });
  // Electron's own cookie/session OSCrypt provider is independent from our
  // config vault. Local/ad-hoc macOS builds use its deterministic mock backend
  // so simply creating a BrowserWindow cannot trigger Keychain prompts.
  if (process.platform === "darwin" && secretStoragePlan.backend === "file") {
    app.commandLine.appendSwitch("use-mock-keychain");
  }
} catch (error) {
  secretStoragePlanError = error instanceof Error ? error : new Error(String(error));
}
if (productIdentity.canonical && process.env.AGENT_BROWSER_DISABLE_LEGACY_MIGRATION !== "1") {
  try {
    const appDataRoot = app.getPath("appData");
    const legacyUserData = path.join(appDataRoot, LEGACY_PRODUCT_NAME);
    const managedUserData = path.join(appDataRoot, APP_DATA_DIR_NAME);
    const legacyChromiumRoot = path.join(os.homedir(), LEGACY_CHROMIUM_CACHE_DIR_NAME);
    const managedChromiumRoot = path.join(os.homedir(), CHROMIUM_CACHE_DIR_NAME);
    const dataReport = migrateLegacyUserData({
      source: legacyUserData,
      target: managedUserData,
      legacyChromiumRoot,
      chromiumRoot: managedChromiumRoot,
    });
    const chromiumReport = migrateLegacyChromiumCache({
      source: legacyChromiumRoot,
      target: managedChromiumRoot,
    });
    if (dataReport.migrated) {
      console.log(`[migration] imported ${dataReport.profileCount} profiles (${dataReport.profileFileCount} files, ${dataReport.profileSymlinkCount} symlinks) from ${LEGACY_PRODUCT_NAME}`);
    }
    if (chromiumReport.migratedVersions.length) {
      console.log(`[migration] imported managed Chromium ${chromiumReport.migratedVersions.join(", ")}`);
    }
  } catch (error) {
    legacyMigrationError = error instanceof Error ? error : new Error(String(error));
    console.error("[migration] legacy data import failed:", legacyMigrationError);
  }
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function createWindow(): void {
  // Harden the UI session before any window exists: deny all permission
  // requests, downloads and webview attachment for the isolated partition.
  const uiSession = session.fromPartition(UI_STORAGE_PARTITION);
  try {
    uiSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  } catch {}
  try {
    uiSession.setPermissionCheckHandler(() => false);
  } catch {}
  try {
    (uiSession as any).setPermissionCheckHandler?.(() => false);
  } catch {}
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Own session partition: keeps the renderer's localStorage out of the
      // default session, whose first-access discovery stalls for seconds while
      // managed browser profiles are running in the user-data tree.
      session: uiSession,
    },
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f5f5f5",
    show: false,
  });

  // Load local HTML
  const htmlPath = path.join(__dirname, "..", "renderer", "index.html");
  const trustedAppUrl = pathToFileURL(htmlPath).toString();
  mainWindow.loadFile(htmlPath).catch((err) => {
    console.error("Failed to load index.html:", err);
  });

  // Open DevTools in dev mode only
  if (process.env.AGENT_BROWSER_DEV === "1") {
    mainWindow.webContents.openDevTools({ mode: "bottom" });
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== trustedAppUrl) event.preventDefault();
  });

  // Deny any attempt to attach a <webview> inside the trusted UI.
  mainWindow.webContents.on("will-attach-webview" as any, (event: any) => {
    event.preventDefault();
  });

  // UI session should never trigger downloads; legitimate downloads go through
  // the main-process controlled flow. Deny defensively.
  try {
    uiSession.on("will-download" as any, (event: any) => {
      try { event.preventDefault(); } catch {}
    });
  } catch {}

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch (e) {
      console.error("Blocked invalid external URL:", e);
    }
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    // Hide instead of close so background profiles keep running and tray remains useful.
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Register all IPC handlers ──
function registerAllHandlers(): void {
  registerProfileHandlers();
  registerProxyHandlers();
  registerDrmHandlers();
  registerStorageHandlers();
  registerSyncHandlers();
  registerAppHandlers();
  registerDetectHandlers();
  registerSettingsHandlers();
  registerAgentHandlers();
  registerMcpHandlers();
  registerApiHandlers();
  registerBrowserHandlers();
  registerWebRtcHandlers();
  registerTeamHandlers();
  registerAutomationHandlers();
  registerAuditHandlers();
  registerDataHandlers();
  registerUpdateHandlers();
  registerObservabilityHandlers();
}

// ── App lifecycle ──
app.whenReady().then(async () => {
  if (legacyMigrationError) {
    dialog.showErrorBox(
      `${PRODUCT_NAME} migration failed`,
      `Your existing data was left unchanged. ${legacyMigrationError.message}`,
    );
    app.quit();
    return;
  }
  if (secretStoragePlanError || !secretStoragePlan) {
    dialog.showErrorBox(
      `${PRODUCT_NAME} credential vault failed`,
      `The credential vault could not be initialized. Your existing data was left unchanged. ${secretStoragePlanError?.message || "No storage plan was available."}`,
    );
    app.quit();
    return;
  }
  try {
    const osStorage = secretStoragePlan.backend === "os"
      ? (await import("electron")).safeStorage
      : undefined;
    const storage = initializeSecretStorage(secretStoragePlan, { osStorage });
    console.log(`[secrets] backend=${storage.backend} reason=${storage.reason}`);
    const migrated = migrateSecrets();
    if (migrated > 0) console.log(`[secrets] migrated ${migrated} at-rest secret field(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      `${PRODUCT_NAME} credential migration failed`,
      `Your encrypted credentials were not changed. ${message}`,
    );
    app.quit();
    return;
  }
  // R11 P2-2: trash retention is real — sweep once at startup and daily
  // after. Previously purgeExpiredTrash only ran when the trash dialog was
  // opened, so "7 days" never elapsed for users who never opened it.
  try {
    const startupPurged = purgeExpiredTrash();
    if (startupPurged.length) console.log("[trash] startup sweep purged " + startupPurged.length + " expired profile(s)");
  } catch { /* best effort */ }
  setInterval(() => {
    try {
      const purged = purgeExpiredTrash();
      if (purged.length) console.log("[trash] daily sweep purged " + purged.length + " expired profile(s)");
    } catch (error) {
      console.error("[trash] daily sweep failed:", error);
    }
  }, 24 * 60 * 60 * 1000).unref();
  // Version-aware release store: auto-rollback after a crash loop,
  // then mark the run healthy once the app has been up for a while.
  const updateState = noteAppStarted();
  if (updateState.history.length) console.log("[updates] active=" + updateState.activeVersion + " history=" + updateState.history.length);
  setTimeout(() => { try { markAppHealthy(); } catch { /* best effort */ } }, 60000);
  process.on("exit", (code) => { if (code !== 0) { try { noteAppCrashed(); } catch { /* best effort */ } } });
  // Crash nets: a desktop controller must survive a stray rejected promise
  // (a failing automation rule, a closed CDP socket) without taking the whole
  // app — including running profiles and the scheduler — down with it.
  // Both handlers log through observability so the event lands in the
  // diagnostic bundle and recent-events ring.
  //
  // Crash-counter wiring (R7 #42): uncaughtException means main-process state
  // may be torn (half-written config, broken singleton) — limping on hides
  // the crash loop from auto-rollback. Record the crash AND exit(1) so the
  // exit-code path bumps crashCount; unhandledRejection stays survive-and-log
  // (a single rejected promise does not tear process state).
  process.on("unhandledRejection", (reason) => {
    logWarn("app.unhandled-rejection", { reason: reason instanceof Error ? reason.stack || reason.message : String(reason) });
  });
  process.on("uncaughtException", (err: Error) => {
    // logError appends synchronously to the log file, noteAppCrashed writes
    // the update state synchronously — both land before exit below.
    logError("app.uncaught-exception", { error: err.stack || err.message });
    try { noteAppCrashed(); } catch { /* best effort — exiting anyway */ }
    // Exit non-zero so supervisors and the exit-code crash path agree this
    // was a crash, not a clean quit (feeds auto-rollback crashCount).
    process.exit(1);
  });
  // Local-only observability: structured log + metrics under the app data dir.
  // Nothing here is transmitted anywhere; see services/observability.ts.
  try {
    configureObservability({ dir: path.join(getAppDataDir(), "logs") });
    logInfo("app.started", { mode: isHeadlessMode() ? "headless" : "gui", platform: process.platform, arch: process.arch });
  } catch (error) {
    console.error("[observability] failed to configure:", error);
  }
  registerAllHandlers();
  // One-time copy of legacy renderer settings (theme / language / wizard
  // state) from the default session into the UI partition. Runs before the
  // window is created so the first paint reads already-migrated values.
  await migrateLegacyRendererStorage();
  const headless = isHeadlessMode();
  if (!headless) {
    createWindow();
  }
  startScheduler();

  // Idle auto-stop for running profiles: stops profiles with no REST/CDP/
  // automation activity for the timeout. Opt-in via AGENT_BROWSER_IDLE_TIMEOUT_MS
  // (0 or unset disables) so existing GUI/headless instances are never
  // surprised; set it in server/Docker deployments to reclaim leaked profiles.
  // Mirrors upstream cloakserve idle cleanup (#352).
  const idleEnv = Number.parseInt(process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || "", 10);
  const idleTimeoutMs = Number.isFinite(idleEnv) && idleEnv > 0 ? idleEnv : 0;
  setIdlePolicyTimeoutMs(idleTimeoutMs);
  if (idleTimeoutMs > 0) {
    const sweepEveryMs = Math.max(1000, Math.min(Math.floor(idleTimeoutMs / 2), 60_000));
    setInterval(() => {
      try {
        const stopped = sweepIdleProfiles(getIdlePolicyTimeoutMs());
        if (stopped.length) console.log("[server] idle sweep stopped " + stopped.length + " profile(s): " + stopped.join(", "));
      } catch (error) {
        console.error("[server] idle sweep failed:", error);
      }
    }, sweepEveryMs).unref();
    console.log("[server] idle profile auto-stop enabled (timeout=" + idleTimeoutMs + "ms, sweep every " + sweepEveryMs + "ms)");
  }

  if (!headless) {
    // Create system tray
    createTray(() => mainWindow, {
      onShow: () => createWindow(),
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
    });

    // Periodically refresh tray menu to show updated profile status.
    // unref: a pending tray tick must not hold the process open on quit.
    setInterval(() => refreshTrayMenu(() => mainWindow, {
      onShow: () => createWindow(),
      onQuit: () => { isQuitting = true; app.quit(); },
    }), 10000).unref();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) { win.show(); win.focus(); }
      }
    });
  } else {
    console.log("[server] headless server mode — no window, no tray; REST + MCP + scheduler active");
  }

  const mcp = startMcpServer();
  mcp.ready.catch((e) => console.error("[mcp] failed to start:", e));

  // Loopback REST API (profiles / proxies / accounts / automation / audit + OpenAPI).
  const api = startRestApiServer();
  api.ready.catch((e) => console.error("[api] failed to start:", e));
});

app.on("window-all-closed", () => {
  // Don't quit on macOS when window is closed — tray keeps running
  if (process.platform !== "darwin" && !isQuitting) {
    // On non-macOS platforms, we still keep running via tray
  }
});

app.on("before-quit", async (event: any) => {
  if (isQuitting) return;
  // Block Electron's default quit so async cleanup can finish; re-trigger quit after.
  event.preventDefault();
  isQuitting = true;
  console.log(`${PRODUCT_NAME} shutting down — cleaning up child processes`);
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T | void> =>
    Promise.race([
      p,
      new Promise<void>((resolve) => setTimeout(() => { console.warn(`[shutdown] ${label} timed out after ${ms}ms`); resolve(); }, ms)),
    ]) as Promise<T | void>;
  try {
    stopAllBrowserProfiles();
  } catch (e) {
    console.error("[shutdown] failed to stop managed Chromium children:", e);
  }
  try {
    const { closeAgentDb } = await import("./services/agent-db.js");
    await withTimeout(Promise.resolve(closeAgentDb()), 2000, "closeAgentDb");
  } catch { /* ignore */ }
  try {
    const { closeJobDb } = await import("./services/job-store.js");
    await withTimeout(Promise.resolve(closeJobDb()), 2000, "closeJobDb");
  } catch { /* ignore */ }
  try {
    destroyTray();
  } catch (e) {
    console.error("[shutdown] failed to destroy tray:", e);
  }
  await withTimeout(stopMcpServer().catch((e) => console.error("[shutdown] failed to stop MCP server:", e)), 2000, "stopMcpServer");
  await withTimeout(stopRestApiServer().catch((e) => console.error("[shutdown] failed to stop REST API server:", e)), 2000, "stopRestApiServer");
  // Give a tick for SIGTERM handlers to flush, then quit for real.
  setTimeout(() => app.quit(), 50);
});
