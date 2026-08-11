// ── Agent Browser Studio system tray ──
// Provides a status-bar icon with menu access to show/quit the app and quick profile actions.
// Uses macOS template image so it adapts to dark/light menu bar.

import { app, Menu, Tray, BrowserWindow, nativeImage } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { listBrowserProfiles } from "./browser-manager.js";
import { tMain } from "./main-i18n.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

export function getTray(): Tray | null {
  return tray;
}

export function createTray(getMainWindow: () => BrowserWindow | null, options: { onShow?: () => void; onQuit?: () => void } = {}): Tray | null {
  if (tray) return tray;
  const iconPath = path.resolve(__dirname, "..", "resources", "tray-icon-Template.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Fallback to a 1x1 transparent image — better than crashing
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
        else {
          (app as any).isQuitting = true;
          app.quit();
        }
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
