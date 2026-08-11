import { app, BrowserWindow, shell } from "electron";
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
import { registerCloakHandlers } from "./ipc/cloak.js";
import { registerAutomationHandlers } from "./ipc/automation.js";
import { registerAuditHandlers } from "./ipc/audit.js";
import { registerDataHandlers } from "./ipc/data.js";
import { startScheduler } from "./services/automation.js";
import { startMcpServer, stopMcpServer } from "./services/mcp-server.js";
import { stopAllCloakProfiles } from "./services/cloak-manager.js";
import { migrateSecrets } from "./services/config-manager.js";
import { createTray, destroyTray, refreshTrayMenu } from "./services/tray-manager.js";
import * as fs from "node:fs";

// ── ESM dirname equivalent ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Normalize app name for consistent cross-platform data paths
if (app.name !== "CloakLite") {
  app.setName("CloakLite");
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: "CloakLite",
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
  if (process.env.ROXY_DEV === "1") {
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
  registerCloakHandlers();
  registerAutomationHandlers();
  registerAuditHandlers();
  registerDataHandlers();
}

// ── App lifecycle ──
app.whenReady().then(() => {
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
  console.log("CloakLite shutting down — cleaning up child processes");
  try {
    stopAllCloakProfiles();
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
