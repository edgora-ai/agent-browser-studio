const { contextBridge, ipcRenderer } = require("electron");

const listenerMap = new WeakMap();

const api = {
  profile: {
    list: () => ipcRenderer.invoke("profile:list"),
    get: (dirId) => ipcRenderer.invoke("profile:get", dirId),
    create: (name, options) => ipcRenderer.invoke("browser:create", { name, ...(options || {}) }),
    delete: (dirId) => ipcRenderer.invoke("profile:delete", dirId),
    // PL-09: recoverable delete — moves the profile to a 7-day local trash.
    trash: (dirId) => ipcRenderer.invoke("profile:trash", dirId),
    trashRestore: (dirId) => ipcRenderer.invoke("profile:trash-restore", dirId),
    trashList: () => ipcRenderer.invoke("profile:trash-list"),
    trashPurge: (dirId) => ipcRenderer.invoke("profile:trash-purge", dirId),
    rename: (dirId, name) => ipcRenderer.invoke("profile:rename", { dirId, name }),
    exportArchive: (dirId, destPath) => ipcRenderer.invoke("profile:export-archive", { dirId, destPath }),
    importArchive: (zipPath) => ipcRenderer.invoke("profile:import-archive", { zipPath }),
    exportArchives: (dirIds, destDir) => ipcRenderer.invoke("profile:export-archives", { dirIds, destDir }),
    importArchives: (zipPaths) => ipcRenderer.invoke("profile:import-archives", { zipPaths }),
    // Cookie management
    cookies: (dirId, filter) => ipcRenderer.invoke("profile:cookies", { dirId, filter }),
    setCookie: (dirId, cookie) => ipcRenderer.invoke("profile:set-cookie", { dirId, ...cookie }),
    deleteCookie: (dirId, domain, name) => ipcRenderer.invoke("profile:delete-cookie", { dirId, domain, name }),
  },
  proxy: {
    list: () => ipcRenderer.invoke("proxy:list"),
    get: (name) => ipcRenderer.invoke("proxy:get", name),
    getProfile: (dirId) => ipcRenderer.invoke("proxy:get-profile", dirId),
    add: (name, config) => ipcRenderer.invoke("proxy:add", { name, config }),
    delete: (name) => ipcRenderer.invoke("proxy:delete", name),
    update: (name, config) => ipcRenderer.invoke("proxy:update", { name, config }),
    rename: (oldName, newName, config) => ipcRenderer.invoke("proxy:rename", { oldName, newName, config }),
    setDefault: (name) => ipcRenderer.invoke("proxy:set-default", name),
    setProfile: (dirId, proxyName, mode) => ipcRenderer.invoke("proxy:set-profile", { dirId, proxyName, mode }),
    healthGet: () => ipcRenderer.invoke("proxy:health-get"),
    healthClear: (name) => ipcRenderer.invoke("proxy:health-clear", name),
    rotate: (name) => ipcRenderer.invoke("proxy:rotate", name),
    rotationInfo: (name) => ipcRenderer.invoke("proxy:rotation-info", name),
    importText: (text, replace) => ipcRenderer.invoke("proxy:import-text", { text, replace }),
    exportCsv: () => ipcRenderer.invoke("proxy:export-csv"),
    qrcode: (name) => ipcRenderer.invoke("proxy:qrcode", { name }),
  },
  drm: {
    status: () => ipcRenderer.invoke("drm:status"),
    setProfile: (dirId, enabled) => ipcRenderer.invoke("drm:set-profile", { dirId, enabled }),
    setCdmPath: (cdmPath) => ipcRenderer.invoke("drm:set-cdm-path", cdmPath),
    ensure: () => ipcRenderer.invoke("drm:ensure"),
    probe: (dirId) => ipcRenderer.invoke("drm:probe", dirId),
  },
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    check: (manifestUrl) => ipcRenderer.invoke("updates:check", { manifestUrl }),
    install: (version) => ipcRenderer.invoke("updates:install", { version }),
    activate: (version) => ipcRenderer.invoke("updates:activate", { version }),
    rollback: () => ipcRenderer.invoke("updates:rollback"),
  },
  detect: {
    proxy: (config) => ipcRenderer.invoke("detect:proxy", config),
    proxyPing: (config) => ipcRenderer.invoke("detect:proxy-ping", config),
    proxyByName: (name) => ipcRenderer.invoke("detect:proxy-by-name", name),
    webrtcLeak: (config) => ipcRenderer.invoke("detect:webrtc-leak", config),
  },
  webrtc: {
    diag: (dirId, opts) => ipcRenderer.invoke("webrtc:diag", { dirId, ...(opts || {}) }),
    diagHistory: (dirId) => ipcRenderer.invoke("webrtc:diag-history", dirId),
    diagClear: (dirId) => ipcRenderer.invoke("webrtc:diag-clear", dirId),
  },
  storage: {
    info: () => ipcRenderer.invoke("storage:info"),
    clearCache: (dirId) => ipcRenderer.invoke("storage:clear-cache", dirId),
    availableDisk: () => ipcRenderer.invoke("storage:available-disk"),
  },
  sync: {
    push: (opts) => ipcRenderer.invoke("sync:push", opts),
    pull: (opts) => ipcRenderer.invoke("sync:pull", opts),
    status: () => ipcRenderer.invoke("sync:status"),
    preview: () => ipcRenderer.invoke("sync:preview"),
    previewDiff: () => ipcRenderer.invoke("sync:preview-diff"),
    configure: (config) => ipcRenderer.invoke("sync:configure", config),
  },
  team: {
    status: () => ipcRenderer.invoke("team:status"),
    init: (name) => ipcRenderer.invoke("team:init", { name }),
    addMember: (deviceId, name, role) => ipcRenderer.invoke("team:add-member", { deviceId, name, role }),
    removeMember: (deviceId) => ipcRenderer.invoke("team:remove-member", { deviceId }),
    setRole: (deviceId, role) => ipcRenderer.invoke("team:set-role", { deviceId, role }),
    rename: (name) => ipcRenderer.invoke("team:rename", { name }),
    setEnabled: (enabled) => ipcRenderer.invoke("team:set-enabled", { enabled }),
  },
  app: {
    paths: () => ipcRenderer.invoke("app:paths"),
    reloadConfig: () => ipcRenderer.invoke("app:reload-config"),
    openDir: (dirPath) => ipcRenderer.invoke("app:open-dir", dirPath),
    version: () => ipcRenderer.invoke("app:get-version"),
    openUrl: (url) => ipcRenderer.invoke("app:open-url", url),
    setLanguage: (lang) => ipcRenderer.invoke("app:set-language", lang),
    getLanguage: () => ipcRenderer.invoke("app:get-language"),
  },
  settings: {
    launchGates: () => ipcRenderer.invoke("settings:launch-gates"),
    setLaunchGates: (gates) => ipcRenderer.invoke("settings:launch-gates:set", gates),
    extensions: (dirId) => ipcRenderer.invoke("settings:extensions", dirId),
    extensionRepository: (filter) => ipcRenderer.invoke("settings:extension-repository", filter),
    addRepositoryExtension: (extId, options) => ipcRenderer.invoke("settings:add-repository-extension", { extId, ...(options || {}) }),
    updateRepositoryExtension: (extId) => ipcRenderer.invoke("settings:update-repository-extension", extId),
    deleteRepositoryExtension: (extId) => ipcRenderer.invoke("settings:delete-repository-extension", extId),
    setRepositoryExtensionMeta: (extId, meta) => ipcRenderer.invoke("settings:set-repository-extension-meta", { extId, ...(meta || {}) }),
    exportSharedExtensionRepository: () => ipcRenderer.invoke("settings:export-shared-extension-repository"),
    deleteExtension: (dirId, extId) => ipcRenderer.invoke("settings:delete-extension", { dirId, extId }),
    installExtension: (dirId, extId) => ipcRenderer.invoke("settings:install-extension", { dirId, extId }),
    toggleExtension: (dirId, extId, enabled) => ipcRenderer.invoke("settings:toggle-extension", { dirId, extId, enabled }),
    checkExtensionUpdate: (dirId, extId) => ipcRenderer.invoke("settings:check-extension-update", { dirId, extId }),
    pickExtensionFile: () => ipcRenderer.invoke("settings:pick-extension-file"),
    pickExtensionDir: () => ipcRenderer.invoke("settings:pick-extension-dir"),
    installLocalExtension: (localPath, opts) => ipcRenderer.invoke("settings:install-local-extension", { path: localPath, ...(opts || {}) }),
    profileExtensions: (dirId) => ipcRenderer.invoke("settings:profile-extensions", dirId),
    setProfileExtensions: (dirId, extensions) => ipcRenderer.invoke("settings:set-profile-extensions", { dirId, extensions }),
    bookmarks: (dirId) => ipcRenderer.invoke("settings:bookmarks", dirId),
    addBookmark: (dirId, url, name) => ipcRenderer.invoke("settings:add-bookmark", { dirId, url, name }),
    writeBookmarks: (dirId, bookmarks) => ipcRenderer.invoke("settings:write-bookmarks", { dirId, bookmarks }),
    preferences: (dirId) => ipcRenderer.invoke("settings:preferences", dirId),
    updatePreferences: (dirId, prefs) => ipcRenderer.invoke("settings:update-preferences", { dirId, prefs }),
    applyProfile: (dirId, settings) => ipcRenderer.invoke("settings:apply-profile", { dirId, settings }),
    agentFsGet: () => ipcRenderer.invoke("settings:agent-fs-get"),
    agentFsSet: (mode, allowlist) => ipcRenderer.invoke("settings:agent-fs-set", { mode, allowlist }),
    pickDir: () => ipcRenderer.invoke("settings:pick-extension-dir"),
  },
  mcp: {
    status: () => ipcRenderer.invoke("mcp:status"),
    restart: () => ipcRenderer.invoke("mcp:restart"),
    revealToken: () => ipcRenderer.invoke("mcp:reveal-token"),
  },
  apiRpc: {
    status: () => ipcRenderer.invoke("api:status"),
    restart: () => ipcRenderer.invoke("api:restart"),
    revealToken: () => ipcRenderer.invoke("api:reveal-token"),
  },
  browser: {
    list: () => ipcRenderer.invoke("browser:list"),
    binary: () => ipcRenderer.invoke("browser:binary"),
    engineStatus: () => ipcRenderer.invoke("browser:engine-status"),
    verifyBinary: () => ipcRenderer.invoke("browser:verify-binary"),
    presets: () => ipcRenderer.invoke("browser:presets"),
    create: (opts) => ipcRenderer.invoke("browser:create", opts),
    delete: (dirId) => ipcRenderer.invoke("browser:delete", dirId),
    launch: (dirId, opts) => ipcRenderer.invoke("browser:launch", { dirId, ...(opts || {}) }),
    stop: (dirId) => ipcRenderer.invoke("browser:stop", dirId),
    status: (dirId) => ipcRenderer.invoke("browser:status", dirId),
    consistencyCheck: (dirId) => ipcRenderer.invoke("browser:consistency-check", dirId),
    captureBaseline: (dirId) => ipcRenderer.invoke("browser:capture-baseline", dirId),
    checkDrift: (dirId) => ipcRenderer.invoke("browser:check-drift", dirId),
    envRisk: (dirId) => ipcRenderer.invoke("browser:env-risk", dirId),
    envRiskHistory: (dirId) => ipcRenderer.invoke("browser:env-risk-history", dirId),
    envRiskClear: (dirId) => ipcRenderer.invoke("browser:env-risk-clear", dirId),
    // PL-07: pick a local Chromium build when no managed engine is installed.
    selectBinary: () => ipcRenderer.invoke("browser:select-binary"),
    setLock: (dirId, locked) => ipcRenderer.invoke("browser:set-lock", { dirId, locked }),
    parseBulkCsv: (text) => ipcRenderer.invoke("browser:parse-bulk-csv", text),
    setSeed: (dirId, seed) => ipcRenderer.invoke("browser:set-seed", { dirId, seed }),
    setMeta: (dirId, meta) => ipcRenderer.invoke("browser:set-meta", { dirId, ...meta }),
    // Batch operations run with bounded concurrency in the main process and
    // report an honest per-item tally (PL-01 / PL-02).
    batchLaunch: (dirIds, concurrency, jobId) => ipcRenderer.invoke("browser:batch-launch", { dirIds, concurrency, jobId }),
    batchStop: (dirIds, concurrency, jobId) => ipcRenderer.invoke("browser:batch-stop", { dirIds, concurrency, jobId }),
    batchCancel: (jobId) => ipcRenderer.invoke("browser:batch-cancel", jobId),
    // allowLaunch is opt-in: a "check" must not silently start a browser (PL-03).
    openRiskCheck: (dirId, opts) => ipcRenderer.invoke("browser:open-risk-check", { dirId, ...(opts || {}) }),
    openApp: (dirId, url) => ipcRenderer.invoke("browser:open-app", { dirId, url }),
    logs: (dirId) => ipcRenderer.invoke("browser:logs", dirId),
  },
  agent: {
    llmConfig: () => ipcRenderer.invoke("agent:llm-config"),
    detectLlmConfig: () => ipcRenderer.invoke("agent:detect-llm-config"),
    saveLlmConfig: (config) => ipcRenderer.invoke("agent:save-llm-config", config),
    chat: (conversationId, message) => ipcRenderer.invoke("agent:chat", { conversationId, message }),
    chatStream: (conversationId, message, streamId) => ipcRenderer.invoke("agent:chat-stream", { conversationId, message, streamId }),
    chatSimple: (messages) => ipcRenderer.invoke("agent:chat-simple", { messages }),
    listSkills: () => ipcRenderer.invoke("agent:skills"),
    taskTemplates: () => ipcRenderer.invoke("agent:task-templates"),
    skills: {
      list: (filter) => ipcRenderer.invoke("agent:skills:list", filter),
      marketplace: (filter) => ipcRenderer.invoke("agent:skills:marketplace", filter),
      add: (skill) => ipcRenderer.invoke("agent:skills:add", skill),
      install: (id) => ipcRenderer.invoke("agent:skills:install", id),
      remove: (id) => ipcRenderer.invoke("agent:skills:remove", id),
      setMeta: (id, meta) => ipcRenderer.invoke("agent:skills:set-meta", { id, ...(meta || {}) }),
      exportShared: () => ipcRenderer.invoke("agent:skills:export-shared"),
      importShared: (entries) => ipcRenderer.invoke("agent:skills:import-shared", entries),
    },
    // AI Skills Hub platform adapter catalog
    platformAdapters: {
      list: (filter) => ipcRenderer.invoke("platform:adapters:list", filter),
      get: (id) => ipcRenderer.invoke("platform:adapter:get", id),
      detect: (url) => ipcRenderer.invoke("platform:adapter:detect", url),
    },
    // Multi-session conversations
    conversations: {
      list: () => ipcRenderer.invoke("agent:conversations:list"),
      get: (id) => ipcRenderer.invoke("agent:conversations:get", id),
      create: (title) => ipcRenderer.invoke("agent:conversations:create", title),
      delete: (id) => ipcRenderer.invoke("agent:conversations:delete", id),
      rename: (id, title) => ipcRenderer.invoke("agent:conversations:rename", { id, title }),
    },
    // Accounts
    accounts: {
      list: () => ipcRenderer.invoke("agent:accounts:list"),
      add: (account) => ipcRenderer.invoke("agent:accounts:add", account),
      update: (index, account) => ipcRenderer.invoke("agent:accounts:update", { index, account }),
      delete: (index) => ipcRenderer.invoke("agent:accounts:delete", index),
      forProfile: (dirId) => ipcRenderer.invoke("agent:accounts:profile", dirId),
      copyUsername: (index) => ipcRenderer.invoke("agent:accounts:copy-username", index),
      copyPassword: (index) => ipcRenderer.invoke("agent:accounts:copy-password", index),
      bind: (index, profileIds) => ipcRenderer.invoke("agent:accounts:bind", { index, profileIds }),
      bulkAdd: (text) => ipcRenderer.invoke("agent:accounts:bulk-add", text),
      bulkCreate: (text, options) => ipcRenderer.invoke("agent:accounts:bulk-create", { text, options }),
    },
  },
  automation: {
    list: () => ipcRenderer.invoke("automation:list"),
    create: (rule) => ipcRenderer.invoke("automation:create", rule),
    update: (rule) => ipcRenderer.invoke("automation:update", rule),
    delete: (ruleId) => ipcRenderer.invoke("automation:delete", ruleId),
    testRun: (ruleId) => ipcRenderer.invoke("automation:test-run", ruleId),
    retryRun: (runId) => ipcRenderer.invoke("automation:retry-run", runId),
    retryJob: (jobId) => ipcRenderer.invoke("automation:retry-job", jobId),
    logs: () => ipcRenderer.invoke("automation:logs"),
    validateCron: (expr) => ipcRenderer.invoke("automation:validate-cron", expr),
    jobs: (opts) => ipcRenderer.invoke("automation:jobs", opts),
    jobGet: (id) => ipcRenderer.invoke("automation:job-get", id),
    jobCancel: (id) => ipcRenderer.invoke("automation:job-cancel", id),
  },
  agentRuns: {
    list: () => ipcRenderer.invoke("agent-run:list"),
    get: (runId) => ipcRenderer.invoke("agent-run:get", runId),
    delete: (runId) => ipcRenderer.invoke("agent-run:delete", runId),
    clear: () => ipcRenderer.invoke("agent-run:clear"),
  },
  agentDb: {
    tables: () => ipcRenderer.invoke("agent-db:tables"),
    tableData: (table, limit, offset) => ipcRenderer.invoke("agent-db:table-data", table, limit, offset),
    query: (sql) => ipcRenderer.invoke("agent-db:query", sql),
    exec: (sql) => ipcRenderer.invoke("agent-db:exec", sql),
  },
  approval: {
    list: () => ipcRenderer.invoke("approval:list"),
    resolve: (id, decision, opts) => ipcRenderer.invoke("approval:resolve", id, decision, opts),
  },
  audit: {
    list: (opts) => ipcRenderer.invoke("audit:list", opts),
    clear: (opts) => ipcRenderer.invoke("audit:clear", opts),
  },
  data: {
    export: (scope) => ipcRenderer.invoke("data:export", scope),
  },
  // Local-only observability (TE-01): structured events on disk + metrics.
  // Nothing here leaves the device; there is no upload path.
  observability: {
    log: (level, event, fields) => ipcRenderer.invoke("obs:event", { level, event, fields }),
    trace: () => ipcRenderer.invoke("obs:trace"),
    timing: (name, ms) => ipcRenderer.invoke("obs:timing", { name, ms }),
    counter: (name, delta) => ipcRenderer.invoke("obs:counter", { name, delta }),
    gauge: (name, value) => ipcRenderer.invoke("obs:gauge", { name, value }),
    metrics: () => ipcRenderer.invoke("obs:metrics"),
    events: (limit, filter) => ipcRenderer.invoke("obs:events", { limit, filter }),
    export: () => ipcRenderer.invoke("obs:export"),
    status: () => ipcRenderer.invoke("obs:status"),
  },
  on: (channel, callback) => {
    const validChannels = ["browser:exited", "profile:updated", "config:changed", "agent:tool-call", "agent:stream-chunk", "agent:stream-tool-call", "agent:stream-done", "agent:stream-error", "agent:run-start", "agent:run-step", "agent:run-finish", "agent:approval-request", "batch:progress"];
    if (validChannels.includes(channel)) {
      const wrapped = (_event, ...args) => callback(...args);
      listenerMap.set(callback, wrapped);
      ipcRenderer.on(channel, wrapped);
    }
  },
  removeListener: (channel, callback) => {
    const wrapped = listenerMap.get(callback);
    ipcRenderer.removeListener(channel, wrapped || callback);
    listenerMap.delete(callback);
  },
};

contextBridge.exposeInMainWorld("agentBrowserAPI", api);
