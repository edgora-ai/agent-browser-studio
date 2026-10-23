import { ipcMain, app, shell } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAppDataDir,
  getConfigPath,
  getProfilesDir,
  reloadConfig,
} from "../services/config-manager.js";
import { findRuntimeChromiumBinaryAsync } from "../services/browser-manager.js";
import { setMainLanguage, getMainLanguage } from "../services/main-i18n.js";
import { collectBuildInfo, type BuildInfo } from "../services/build-info.js";
import { bundledBrowsersRoot } from "../services/bundled-native-browsers.js";
import { getEngineStatus } from "../services/browser-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** macOS .app bundle root for an executable path, or null outside a bundle. */
function containingAppBundle(execPath: string): string | null {
  const marker = ".app/Contents/";
  const index = execPath.indexOf(marker);
  return index >= 0 ? execPath.slice(0, index + 4) : null;
}

/** Installed-engine versions are best-effort labels; absent stays null. */
function installedEngineVersions(): { chromium: string | null; firefox: string | null } {
  try {
    const engines = getEngineStatus();
    return { chromium: engines.chromium.version ?? null, firefox: engines.firefox.version ?? null };
  } catch {
    return { chromium: null, firefox: null };
  }
}

export function registerAppHandlers(): void {
  ipcMain.handle("app:quit", async () => {
    // A renderer window.close() only hides to tray. Use the existing before-quit
    // cleanup chain for an explicit exit; the reply acknowledges the request,
    // not completion of process shutdown.
    app.quit();
    return { success: true };
  });

  ipcMain.handle("app:paths", async () => {
    const appDataDir = getAppDataDir();
    const profilesDir = getProfilesDir();
    return {
      chromiumBin: await findRuntimeChromiumBinaryAsync(),
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
    ].filter((p): p is string => Boolean(p));
    const resolved = path.resolve(dirPath);
    const profilesRoot = path.resolve(getProfilesDir());
    const isManagedProfilePath = resolved === profilesRoot || resolved.startsWith(profilesRoot + path.sep);
    const isAllowed = isManagedProfilePath || allowedPaths.some((allowedPath) => resolved === path.resolve(allowedPath));
    if (!isAllowed) {
      const binary = await findRuntimeChromiumBinaryAsync();
      if (!binary || resolved !== path.resolve(binary)) throw new Error("Refusing to open unmanaged path");
    }
    await shell.openPath(resolved);
    return { success: true };
  });

  ipcMain.handle("app:get-version", async () => {
    return app.getVersion();
  });

  // Read-only build identity for the About dialog. Everything is observed from
  // this binary and host: no network, no config mutation, no license code.
  ipcMain.handle("app:get-build-info", async (): Promise<BuildInfo> => {
    // package.json version inside a packaged app comes from app.asar; in dev it
    // is the checked-out tree. app.getVersion() already resolves that same
    // value, so it is the single source for the version string.
    // process.resourcesPath is set by Electron at runtime. Deriving it from the
    // asar location is the same directory and keeps the payload correct under
    // harnesses that supply app.getAppPath() without that runtime property.
    const appPath = app.getAppPath();
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ||
      (appPath.endsWith("app.asar") ? path.dirname(appPath) : null);
    const info = collectBuildInfo({
      pkg: { name: "agent-browser-studio", version: app.getVersion() },
      packaged: app.isPackaged,
      appPath,
      resourcesPath,
      bundleRoot: process.platform === "darwin" ? containingAppBundle(process.execPath) : null,
      mainEntry: path.join(__dirname, "..", "index.js"),
      enginesRoot: bundledBrowsersRoot(process.platform, resourcesPath),
      runtime: {
        electron: process.versions.electron ?? "",
        chrome: process.versions.chrome ?? "",
        node: process.versions.node ?? "",
        v8: process.versions.v8 ?? "",
        modules: String(process.versions.modules ?? ""),
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        osName: os.type() || null,
        osVersion: typeof os.version === "function" ? os.version() : null,
      },
      locale: { app: app.getLocale(), system: Intl.DateTimeFormat().resolvedOptions().locale },
      appId: "com.ahoo.agent-browser-studio",
    });
    // Installed engine versions are labels for this host; their absence stays
    // null rather than being filled from the bundled manifest.
    return { ...info, engineInstalled: installedEngineVersions() };
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
