// ── Agent Browser Studio system tray ──
// Provides a status-bar icon with menu access to show/quit the app and quick profile actions.
// Uses macOS template image so it adapts to dark/light menu bar.

import { app, Menu, Tray, BrowserWindow, nativeImage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listBrowserProfiles } from "./browser-manager.js";
import { tMain } from "./main-i18n.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

export function getTray(): Tray | null {
  return tray;
}

/**
 * Locate the menu-bar template.
 *
 * The compiled layout is dist/main/services/tray-manager.js, so the asset sits
 * two levels up in dist/resources — not one. Resolving ".."/"resources" pointed
 * at dist/main/resources, which has never existed, so the tray silently fell
 * back to a blank image and macOS showed no icon at all. Check the known
 * locations in order and let the caller know when none of them hit, rather than
 * failing silently.
 */
function resolveTrayIcon(): { path: string | null; tried: string[] } {
  const tried = [
    path.resolve(__dirname, "..", "..", "resources", "tray-icon-Template.png"),
    path.resolve(__dirname, "..", "resources", "tray-icon-Template.png"),
    path.resolve(app.getAppPath(), "dist", "resources", "tray-icon-Template.png"),
  ];
  // extraResources copies land beside the app bundle, outside the asar.
  if (process.resourcesPath) {
    tried.push(path.join(process.resourcesPath, "tray-icon-Template.png"));
  }
  for (const p of tried) {
    try {
      if (fs.existsSync(p)) return { path: p, tried };
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return { path: null, tried };
}

export function createTray(getMainWindow: () => BrowserWindow | null, options: { onShow?: () => void; onQuit?: () => void } = {}): Tray | null {
  if (tray) return tray;
  const { path: iconPath, tried } = resolveTrayIcon();
  let image = nativeImage.createEmpty();
  if (iconPath) {
    image = nativeImage.createFromPath(iconPath);
  }
  if (image.isEmpty()) {
    // A blank tray is a real defect, not a fallback worth hiding: without this
    // line the icon just never appears and nothing points at why.
    console.error("[tray] template icon not found; menu-bar icon will be blank. Tried:", tried);
    image = nativeImage.createEmpty();
  } else {
    // Mark as template image so macOS auto-tints to match menu bar
    image.setTemplateImage(true);
  }
  try {
    tray = new Tray(image);
  } catch (e) {
    console.error("[tray] failed to create tray icon:", e);
    return null;
  }

  tray.setToolTip(tMain("tray.tooltip", "Agent Browser Studio"));
  refreshTrayMenu(getMainWindow, options);

  tray.on("click", () => {
    const win = getMainWindow();
    if (!win) {
      options.onShow?.();
      return;
    }
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return tray;
}

export function refreshTrayMenu(
  getMainWindow: () => BrowserWindow | null,
  options: { onShow?: () => void; onQuit?: () => void } = {},
): void {
  if (!tray) return;
  let runningCount = 0;
  try {
    runningCount = listBrowserProfiles().filter((p) => p.running).length;
  } catch {
    runningCount = 0;
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: tMain("tray.show", "Show Agent Browser Studio"),
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        } else {
          options.onShow?.();
        }
      },
    },
    {
      label: runningCount > 0 ? `${tMain("tray.running", "Running profiles")}: ${runningCount}` : tMain("tray.idle", "No profiles running"),
      enabled: false,
    },
    { type: "separator" },
    {
      label: tMain("tray.quit", "Quit Agent Browser Studio"),
      click: () => {
        if (options.onQuit) options.onQuit();
        else app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

export function destroyTray(): void {
  if (tray) {
    try { tray.destroy(); } catch (e) { console.error("[tray] failed to destroy:", e); }
    tray = null;
  }
}
