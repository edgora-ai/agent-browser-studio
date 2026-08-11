import { ipcMain, app, shell } from "electron";
import * as path from "node:path";
import {
  getAppDataDir,
  getConfigPath,
  getProfilesDir,
  reloadConfig,
} from "../services/config-manager.js";
import { findRuntimeChromiumBinary } from "../services/cloak-manager.js";
import { setMainLanguage, getMainLanguage } from "../services/main-i18n.js";

export function registerAppHandlers(): void {
  ipcMain.handle("app:paths", async () => {
    const appDataDir = getAppDataDir();
    const profilesDir = getProfilesDir();
    return {
      chromiumBin: findRuntimeChromiumBinary(),
      appDataDir,
      profilesDir,
      configPath: getConfigPath(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    };
  });

  ipcMain.handle("app:reload-config", async () => {
    reloadConfig();
    return { success: true };
  });

  ipcMain.handle("app:open-dir", async (_event, dirPath: string) => {
    const allowedPaths = [
      getAppDataDir(),
      getProfilesDir(),
      getConfigPath(),
      findRuntimeChromiumBinary(),
    ].filter((p): p is string => Boolean(p));
    const resolved = path.resolve(dirPath);
    const profilesRoot = path.resolve(getProfilesDir());
    const isManagedProfilePath = resolved === profilesRoot || resolved.startsWith(profilesRoot + path.sep);
    const isAllowed = isManagedProfilePath || allowedPaths.some((allowedPath) => resolved === path.resolve(allowedPath));
    if (!isAllowed) {
      throw new Error("Refusing to open unmanaged path");
    }
    await shell.openPath(resolved);
    return { success: true };
  });

  ipcMain.handle("app:get-version", async () => {
    return app.getVersion();
  });

  ipcMain.handle("app:open-url", async (_event, url: string) => {
    if (typeof url !== "string" || url.length > 2048) throw new Error("Invalid URL");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) URLs allowed");
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("app:set-language", async (_event, lang: string) => {
    setMainLanguage(lang);
    return { success: true, language: getMainLanguage() };
  });

  ipcMain.handle("app:get-language", async () => {
    return { language: getMainLanguage() };
  });
}
