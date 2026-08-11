import { app, BrowserWindow, dialog, shell } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerProfileHandlers } from "./ipc/profile.js";
import { registerProxyHandlers } from "./ipc/proxy.js";
import { registerStorageHandlers } from "./ipc/storage.js";
import { registerSyncHandlers } from "./ipc/sync.js";
import { registerAppHandlers } from "./ipc/app.js";
import { registerDetectHandlers } from "./ipc/detect.js";
import { registerSettingsHandlers } from "./ipc/settings.js";
import { registerAgentHandlers } from "./ipc/agent.js";
import { registerMcpHandlers } from "./ipc/mcp.js";
import { registerBrowserHandlers } from "./ipc/browser.js";
import { registerAutomationHandlers } from "./ipc/automation.js";
import { registerAuditHandlers } from "./ipc/audit.js";
import { registerDataHandlers } from "./ipc/data.js";
import { startScheduler } from "./services/automation.js";
import { startMcpServer, stopMcpServer } from "./services/mcp-server.js";
import { stopAllBrowserProfiles } from "./services/browser-manager.js";
import { migrateSecrets } from "./services/config-manager.js";
import { createTray, destroyTray, refreshTrayMenu } from "./services/tray-manager.js";
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

// ── ESM dirname equivalent ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Establish the new product identity before any lazy user-data path resolves.
// Explicit --user-data-dir runs (tests and diagnostics) stay isolated and do
// not import real user data.
const productIdentity = configureProductIdentity(app);
let legacyMigrationError: Error | null = null;
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
  registerStorageHandlers();
  registerSyncHandlers();
  registerAppHandlers();
  registerDetectHandlers();
  registerSettingsHandlers();
  registerAgentHandlers();
  registerMcpHandlers();
  registerBrowserHandlers();
  registerAutomationHandlers();
  registerAuditHandlers();
  registerDataHandlers();
}

// ── App lifecycle ──
app.whenReady().then(() => {
  if (legacyMigrationError) {
    dialog.showErrorBox(
      `${PRODUCT_NAME} migration failed`,
      `Your existing data was left unchanged. ${legacyMigrationError.message}`,
    );
    app.quit();
    return;
  }
  registerAllHandlers();
  createWindow();
  // Encrypt any plaintext secrets from prior versions (no-op if keychain
  // unavailable or already encrypted).
  try {
    const migrated = migrateSecrets();
    if (migrated > 0) console.log(`[secrets] encrypted ${migrated} at-rest secret field(s)`);
  } catch (e) { console.error("[secrets] migration failed:", e); }
  startScheduler();

  // Create system tray
  createTray(() => mainWindow, {
    onShow: () => createWindow(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  const mcp = startMcpServer();
  mcp.ready.catch((e) => console.error("[mcp] failed to start:", e));

  // Periodically refresh tray menu to show updated profile status
  setInterval(() => refreshTrayMenu(() => mainWindow, {
    onShow: () => createWindow(),
    onQuit: () => { isQuitting = true; app.quit(); },
  }), 10000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) { win.show(); win.focus(); }
    }
  });
});

app.on("window-all-closed", () => {
  // Don't quit on macOS when window is closed — tray keeps running
  if (process.platform !== "darwin" && !isQuitting) {
    // On non-macOS platforms, we still keep running via tray
  }
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  console.log(`${PRODUCT_NAME} shutting down — cleaning up child processes`);
  try {
    stopAllBrowserProfiles();
  } catch (e) {
    console.error("[shutdown] failed to stop managed Chromium children:", e);
  }
  try {
    // Flush + close the agent SQLite DB so WAL is checkpointed.
    const { closeAgentDb } = await import("./services/agent-db.js");
    closeAgentDb();
  } catch { /* ignore */ }
  try {
    const { closeJobDb } = await import("./services/job-store.js");
    closeJobDb();
  } catch { /* ignore */ }
  try {
    destroyTray();
  } catch (e) {
    console.error("[shutdown] failed to destroy tray:", e);
  }
  // Stop MCP server (best-effort — non-blocking timeout)
  Promise.race([
    stopMcpServer(),
    new Promise(resolve => setTimeout(resolve, 500)),
  ]).catch((e) => console.error("[shutdown] failed to stop MCP server:", e));
});
