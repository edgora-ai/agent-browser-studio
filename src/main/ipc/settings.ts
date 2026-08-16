import { ipcMain, dialog } from "electron";
import {
  readBookmarks,
  writeBookmarks,
  addBookmark,
  readPreferences,
  writePreferences,
  applyProfileSettings,
  checkExtensionUpdate,
} from "../services/launch-args.js";
import { getConfig, saveConfig, normalizeProfileExtensionMap } from "../services/config-manager.js";
import {
  addOrUpdateChromeStoreExtension,
  installLocalExtension,
  updateRepositoryExtension,
  deleteRepositoryExtension,
  exportSharedExtensionRepository,
  listExtensionRepository,
  setRepositoryExtensionMeta,
} from "../services/extension-repository.js";
import { validateDirId } from "../services/utils.js";

export function registerSettingsHandlers(): void {

  // ── Launch safety gates (blockOnConsistencyConflict / fingerprint drift / env risk) ──
  ipcMain.handle("settings:launch-gates", async () => {
    const cfg = getConfig() as any;
    return {
      blockOnConsistencyConflict: cfg.blockOnConsistencyConflict === true,
      blockOnProxyRisk: cfg.blockOnProxyRisk === true,
      blockOnFingerprintDrift: cfg.blockOnFingerprintDrift !== false,
      blockOnEnvironmentRisk: cfg.blockOnEnvironmentRisk === true,
    };
  });

  ipcMain.handle("settings:launch-gates:set", async (_event, gates: { blockOnConsistencyConflict?: boolean; blockOnProxyRisk?: boolean; blockOnFingerprintDrift?: boolean; blockOnEnvironmentRisk?: boolean }) => {
    const cfg = getConfig() as any;
    if (typeof gates.blockOnConsistencyConflict === "boolean") cfg.blockOnConsistencyConflict = gates.blockOnConsistencyConflict;
    if (typeof gates.blockOnProxyRisk === "boolean") cfg.blockOnProxyRisk = gates.blockOnProxyRisk;
    if (typeof gates.blockOnFingerprintDrift === "boolean") cfg.blockOnFingerprintDrift = gates.blockOnFingerprintDrift;
    if (typeof gates.blockOnEnvironmentRisk === "boolean") cfg.blockOnEnvironmentRisk = gates.blockOnEnvironmentRisk;
    saveConfig(cfg);
    return { success: true };
  });

  // ── Extension repository + per-profile selection ──
  ipcMain.handle("settings:extensions", async (_event, dirId: string) => {
    validateDirId(dirId);
    const cfg = getConfig() as any;
    const enabledMap = cfg.browserProfiles?.[dirId]?.extensions || {};
    return listExtensionRepository().map((entry) => ({ ...entry, enabled: enabledMap[entry.id] === true }));
  });

  ipcMain.handle("settings:extension-repository", async (_event, filter?: string) => {
    return listExtensionRepository(filter);
  });

  ipcMain.handle("settings:add-repository-extension", async (_event, params: { extId: string; shared?: boolean; tags?: string[] }) => {
    try {
      return { success: true, entry: await addOrUpdateChromeStoreExtension(params.extId, { shared: params.shared, tags: params.tags }) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:update-repository-extension", async (_event, extId: string) => {
    try {
      return { success: true, entry: await updateRepositoryExtension(extId) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:delete-repository-extension", async (_event, extId: string) => {
    try {
      return { success: deleteRepositoryExtension(extId) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:set-repository-extension-meta", async (_event, params: { extId: string; shared?: boolean; tags?: string[] }) => {
    try {
      return { success: true, entry: setRepositoryExtensionMeta(params.extId, { shared: params.shared, tags: params.tags }) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:export-shared-extension-repository", async () => {
    return exportSharedExtensionRepository();
  });

  ipcMain.handle("settings:delete-extension", async (_event, {
    dirId, extId,
  }: { dirId: string; extId: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      return { success: toggleExtension(dirId, extId, false) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:install-extension", async (_event, {
    dirId, extId,
  }: { dirId: string; extId: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      assertProfileExists(dirId);
      await addOrUpdateChromeStoreExtension(extId);
      return { success: toggleExtension(dirId, extId, true) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:toggle-extension", async (_event, {
    dirId, extId, enabled,
  }: { dirId: string; extId: string; enabled: boolean }): Promise<{ success: boolean; error?: string }> => {
    try {
      return { success: toggleExtension(dirId, extId, enabled) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:check-extension-update", async (_event, {
    dirId, extId,
  }: { dirId: string; extId: string }) => {
    return checkExtensionUpdate(dirId, extId);
  });

  // Local file picker for CRX/ZIP extensions
  ipcMain.handle("settings:pick-extension-file", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Extensions", extensions: ["crx", "zip"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Local directory picker for unpacked extensions
  ipcMain.handle("settings:pick-extension-dir", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Install a local CRX/ZIP file or unpacked directory into the repository
  ipcMain.handle("settings:install-local-extension", async (_event, params: { path: string; shared?: boolean; tags?: string[] }) => {
    try {
      const entry = await installLocalExtension(params.path, { shared: params.shared, tags: params.tags });
      return { success: true, entry };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // Per-profile extension enable/disable via browser profile metadata
  ipcMain.handle("settings:profile-extensions", async (_event, dirId: string) => {
    validateDirId(dirId);
    const cfg = getConfig() as any;
    const meta = Object.hasOwn(cfg.browserProfiles || {}, dirId) ? cfg.browserProfiles[dirId] : null;
    return meta?.extensions || {};
  });

  ipcMain.handle("settings:set-profile-extensions", async (_event, params: {
    dirId: string; extensions: Record<string, boolean>;
  }) => {
    validateDirId(params.dirId);
    const cfg = structuredClone(getConfig()) as any;
    const meta = Object.hasOwn(cfg.browserProfiles || {}, params.dirId) ? cfg.browserProfiles[params.dirId] : null;
    if (!meta) return { success: false, error: "Browser profile not found" };
    try {
      meta.extensions = normalizeRepositoryExtensionSelection(params.extensions, cfg.extensionRepository || {});
      saveConfig(cfg);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // ── Agent file access config ──
  ipcMain.handle("settings:agent-fs-get", async () => {
    const cfg = getConfig() as any;
    return cfg.agentFs || { mode: "sandbox", allowlist: [] };
  });

  ipcMain.handle("settings:agent-fs-set", async (_event, params: { mode: string; allowlist?: string[] }) => {
    const cfg = structuredClone(getConfig()) as any;
    cfg.agentFs = { mode: params.mode, allowlist: Array.isArray(params.allowlist) ? params.allowlist : [] };
    saveConfig(cfg); // normalizes via normalizeAgentFs
    return { success: true, agentFs: getConfig().agentFs };
  });

  // ── Bookmarks ──
  ipcMain.handle("settings:bookmarks", async (_event, dirId: string) => {
    return readBookmarks(dirId);
  });

  ipcMain.handle("settings:add-bookmark", async (_event, {
    dirId,
    url,
    name,
  }: {
    dirId: string; url: string; name: string;
  }): Promise<{ success: boolean }> => {
    return { success: addBookmark(dirId, url, name) };
  });

  ipcMain.handle("settings:write-bookmarks", async (_event, {
    dirId,
    bookmarks,
  }: {
    dirId: string; bookmarks: any;
  }): Promise<{ success: boolean }> => {
    return { success: writeBookmarks(dirId, bookmarks) };
  });

  // ── Preferences ──
  ipcMain.handle("settings:preferences", async (_event, dirId: string) => {
    return readPreferences(dirId);
  });

  ipcMain.handle("settings:update-preferences", async (_event, {
    dirId,
    prefs,
  }: {
    dirId: string; prefs: any;
  }): Promise<{ success: boolean }> => {
    return { success: writePreferences(dirId, prefs) };
  });

  // ── Profile Settings ──
  ipcMain.handle("settings:apply-profile", async (_event, {
    dirId,
    settings,
  }: {
    dirId: string;
    settings: {
      homepage?: string;
      startupUrls?: string[];
      allowPopups?: string[];
      blockPopups?: string[];
      downloadDir?: string;
      pdfDownload?: boolean;
    };
  }): Promise<{ success: boolean }> => {
    return { success: applyProfileSettings(dirId, settings) };
  });
}

// ── Extension selection helpers ──

function assertProfileExists(dirId: string): void {
  validateDirId(dirId);
  const cfg = getConfig() as any;
  if (!cfg.browserProfiles?.[dirId]) throw new Error("Browser profile not found");
}

function normalizeRepositoryExtensionSelection(extensions: Record<string, boolean>, repository: Record<string, unknown>): Record<string, boolean> {
  const normalized = normalizeProfileExtensionMap(extensions);
  for (const [extId, enabled] of Object.entries(normalized)) {
    if (enabled && !repository[extId]) throw new Error(`Extension is not in the private repository: ${extId}`);
  }
  return normalized;
}

function toggleExtension(dirId: string, extId: string, enabled: boolean): boolean {
  validateDirId(dirId);
  const cfg = structuredClone(getConfig()) as any;
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta) throw new Error("Browser profile not found");
  if (!cfg.extensionRepository?.[extId]) throw new Error("Extension is not in the private repository");
  meta.extensions = normalizeProfileExtensionMap({ ...(meta.extensions || {}), [extId]: enabled });
  saveConfig(cfg);
  return true;
}
