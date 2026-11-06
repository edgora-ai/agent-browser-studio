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
import { getConfig, saveConfig, normalizeProfileExtensionMap, assertProfileWritable } from "../services/config-manager.js";
import { transact } from "../services/config/store.js";
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
import { requireSettingsMutation } from "../services/team.js";

type SettingsIpcHandler = Parameters<typeof ipcMain.handle>[1];

/** Authorize before argument decoding, filesystem reads, staging or downloads. */
function handleSettingsMutation(channel: string, handler: SettingsIpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const gate = requireSettingsMutation();
    if (!gate.ok) return { success: false, error: gate.error };
    try { return await handler(event, ...args); }
    catch (error: any) { return { success: false, error: error?.message || String(error) }; }
  });
}

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

  handleSettingsMutation("settings:launch-gates:set", async (_event, gates: { blockOnConsistencyConflict?: boolean; blockOnProxyRisk?: boolean; blockOnFingerprintDrift?: boolean; blockOnEnvironmentRisk?: boolean }) => {
    // Security policy: authorize before decoding, then publish only after the
    // store's atomic rename. A failed write must not relax live launch checks.
    getConfig(); // Initialize the existing store before requesting its draft.
    transact((cfg) => {
      if (typeof gates.blockOnConsistencyConflict === "boolean") cfg.blockOnConsistencyConflict = gates.blockOnConsistencyConflict;
      if (typeof gates.blockOnProxyRisk === "boolean") cfg.blockOnProxyRisk = gates.blockOnProxyRisk;
      if (typeof gates.blockOnFingerprintDrift === "boolean") cfg.blockOnFingerprintDrift = gates.blockOnFingerprintDrift;
      if (typeof gates.blockOnEnvironmentRisk === "boolean") cfg.blockOnEnvironmentRisk = gates.blockOnEnvironmentRisk;
    });
    return { success: true };
  });

  // ── Terminal notifications (M3) ──
  // Both default OFF: the in-app record is always kept, and the OS banner is
  // something the user opts into. Follows the launch-gates shape above — save
  // on change, no save button, and only explicitly supplied booleans may change.
  ipcMain.handle("settings:automation-notify", async () => {
    const cfg = getConfig() as any;
    return {
      system: cfg.automationNotify?.system === true,
      sound: cfg.automationNotify?.sound === true,
    };
  });

  handleSettingsMutation("settings:automation-notify:set", async (_event, prefs: unknown) => {
    // The wrapper authorizes before decoding. Reject malformed partial updates
    // before creating a draft; never mutate getConfig()'s committed live object.
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
      throw new Error("Automation notification preferences must be an object");
    }
    // Preserve the existing partial-update contract: omitted/non-boolean fields
    // keep their current value. Read each input field once, after authorization.
    const { system, sound } = prefs as { system?: unknown; sound?: unknown };
    getConfig(); // Initialize the existing store before requesting its live-base draft.
    const automationNotify = transact((cfg) => {
      cfg.automationNotify = {
        system: typeof system === "boolean" ? system : cfg.automationNotify?.system === true,
        sound: typeof sound === "boolean" ? sound : cfg.automationNotify?.sound === true,
      };
      return { ...cfg.automationNotify };
    });
    // transact returns only after rename/publication. The response is detached.
    return { success: true, automationNotify };
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

  handleSettingsMutation("settings:add-repository-extension", async (_event, params: { extId: string; shared?: boolean; tags?: string[] }) => {
    try {
      return { success: true, entry: await addOrUpdateChromeStoreExtension(params.extId, { shared: params.shared, tags: params.tags }) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  handleSettingsMutation("settings:update-repository-extension", async (_event, extId: string) => {
    try {
      return { success: true, entry: await updateRepositoryExtension(extId) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  handleSettingsMutation("settings:delete-repository-extension", async (_event, extId: string) => {
    try {
      return { success: deleteRepositoryExtension(extId) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  handleSettingsMutation("settings:set-repository-extension-meta", async (_event, params: { extId: string; shared?: boolean; tags?: string[] }) => {
    try {
      return { success: true, entry: setRepositoryExtensionMeta(params.extId, { shared: params.shared, tags: params.tags }) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("settings:export-shared-extension-repository", async () => {
    return exportSharedExtensionRepository();
  });

  handleSettingsMutation("settings:delete-extension", async (_event, {
    dirId, extId,
  }: { dirId: string; extId: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      return { success: toggleExtension(dirId, extId, false) };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  });

  handleSettingsMutation("settings:install-extension", async (_event, {
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

  handleSettingsMutation("settings:toggle-extension", async (_event, {
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
  handleSettingsMutation("settings:install-local-extension", async (_event, params: { path: string; shared?: boolean; tags?: string[] }) => {
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

  handleSettingsMutation("settings:set-profile-extensions", async (_event, params: {
    dirId: string; extensions: Record<string, boolean>;
  }) => {
    validateDirId(params.dirId);
    assertProfileWritable(params.dirId);
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

  handleSettingsMutation("settings:agent-fs-set", async (_event, params: { mode: string; allowlist?: string[] }) => {
    const cfg = structuredClone(getConfig()) as any;
    cfg.agentFs = { mode: params.mode, allowlist: Array.isArray(params.allowlist) ? params.allowlist : [] };
    saveConfig(cfg); // normalizes via normalizeAgentFs
    return { success: true, agentFs: getConfig().agentFs };
  });

  // ── Bookmarks ──
  ipcMain.handle("settings:bookmarks", async (_event, dirId: string) => {
    return readBookmarks(dirId);
  });

  handleSettingsMutation("settings:add-bookmark", async (_event, {
    dirId,
    url,
    name,
  }: {
    dirId: string; url: string; name: string;
  }): Promise<{ success: boolean }> => {
    validateDirId(dirId);
    assertProfileWritable(dirId);
    return { success: addBookmark(dirId, url, name) };
  });

  handleSettingsMutation("settings:write-bookmarks", async (_event, {
    dirId,
    bookmarks,
  }: {
    dirId: string; bookmarks: any;
  }): Promise<{ success: boolean }> => {
    validateDirId(dirId);
    assertProfileWritable(dirId);
    return { success: writeBookmarks(dirId, bookmarks) };
  });

  // ── Preferences ──
  ipcMain.handle("settings:preferences", async (_event, dirId: string) => {
    return readPreferences(dirId);
  });

  handleSettingsMutation("settings:update-preferences", async (_event, {
    dirId,
    prefs,
  }: {
    dirId: string; prefs: any;
  }): Promise<{ success: boolean }> => {
    validateDirId(dirId);
    assertProfileWritable(dirId);
    return { success: writePreferences(dirId, prefs) };
  });

  // ── Profile Settings ──
  handleSettingsMutation("settings:apply-profile", async (_event, {
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
    validateDirId(dirId);
    assertProfileWritable(dirId);
    return { success: applyProfileSettings(dirId, settings) };
  });
}

// ── Extension selection helpers ──

function assertProfileExists(dirId: string): void {
  validateDirId(dirId);
  assertProfileWritable(dirId);
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
  assertProfileWritable(dirId);
  const cfg = structuredClone(getConfig()) as any;
  const meta = cfg.browserProfiles?.[dirId];
  if (!meta) throw new Error("Browser profile not found");
  if (!cfg.extensionRepository?.[extId]) throw new Error("Extension is not in the private repository");
  meta.extensions = normalizeProfileExtensionMap({ ...(meta.extensions || {}), [extId]: enabled });
  saveConfig(cfg);
  return true;
}
