export type ProxyMode = "none" | "default" | "named";

export interface ProxyConfig {
  type: "http" | "socks5" | "socks5h";
  host: string;
  port: number;
  username?: string;
  password?: string;
  bypassList?: string[];
}

export interface RedactedProxyConfig extends Omit<ProxyConfig, "password"> {
  hasAuth?: boolean;
}

export interface RedactedLlmConfig extends Omit<{
  provider: "openai" | "claude" | "custom";
  apiKey: string;
  apiUrl?: string;
  model?: string;
}, "apiKey"> {
  hasApiKey?: boolean;
}

export interface RedactedPlatformAccount {
  platformUrl: string;
  platformUserName: string;
  profileIds?: string[];
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
  hasPassword?: boolean;
}

export interface ResolvedProfileProxy {
  mode: ProxyMode;
  name: string | null;
  config: RedactedProxyConfig | null;
}

export interface BrowserProfileInfo {
  dirId: string;
  name: string;
  version: string;
  fingerprintSeed: number;
  platform: "windows" | "macos" | string;
  timezone: string | null;
  locale: string | null;
  webrtcMode: "auto" | "real" | "altered" | "disable";
  webrtcIp: string | null;
  geolocationMode: "real" | "disable" | "custom";
  geolocationLatitude: number | null;
  geolocationLongitude: number | null;
  geolocationAccuracy: number | null;
  gpuVendor: string | null;
  gpuRenderer: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  storageQuota: number | null;
  taskbarHeight: number | null;
  fontsDir: string | null;
  proxyMode: ProxyMode;
  proxyName: string | null;
  note: string | null;
  tags: string[];
  syncedAt: number | null;
  syncStatus: "synced" | "dirty" | "never";
  lastModified: number;
  running: boolean;
  pid: number | null;
  cdpPort: number | null;
}

export interface ManagedChromiumStatus {
  path: string | null;
  version: string | null;
  source: "managed" | "configured" | null;
  installed: boolean;
  platform: string;
  cacheDir: string | null;
  installedVersions: Array<{ version: string; path: string }>;
}

export interface ExtensionRepositoryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "chrome-web-store";
  chromeStoreUrl: string;
  updateUrl: string;
  unpackedPath: string;
  packageHash: string;
  manifestHash: string;
  shared: boolean;
  tags: string[];
  addedAt: number;
  updatedAt: number;
}

export interface SkillRepositoryEntry {
  id: string;
  name: string;
  title: string;
  version: string;
  description: string;
  source: "built-in" | "local" | "shared-catalog";
  tools: string[];
  prompt: string;
  shared: boolean;
  enabled: boolean;
  tags: string[];
  author?: string;
  homepage?: string;
  packageHash?: string;
  addedAt: number;
  updatedAt: number;
}

export interface AgentBrowserAPI {
  profile: {
    list: () => Promise<any[]>;
    get: (dirId: string) => Promise<any>;
    create: (name: string, options?: any) => Promise<{ dirId: string }>;
    delete: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    rename: (dirId: string, name: string) => Promise<{ success: boolean; error?: string }>;
    cookies: (dirId: string, filter?: string) => Promise<any[]>;
    setCookie: (dirId: string, cookie: any) => Promise<{ success: boolean; error?: string }>;
    deleteCookie: (dirId: string, domain: string, name: string) => Promise<{ success: boolean; error?: string }>;
  };
  proxy: {
    list: () => Promise<Array<{ name: string; config: RedactedProxyConfig; isDefault: boolean }>>;
    get: (name: string) => Promise<RedactedProxyConfig | null>;
    getProfile: (dirId: string) => Promise<ResolvedProfileProxy>;
    add: (name: string, config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
    delete: (name: string) => Promise<{ success: boolean; error?: string }>;
    update: (name: string, config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
    rename: (oldName: string, newName: string, config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
    setDefault: (name: string) => Promise<{ success: boolean; error?: string }>;
    setProfile: (dirId: string, proxyName: string | null, mode?: ProxyMode) => Promise<{ success: boolean; error?: string }>;
  };
  detect: {
    proxy: (config: ProxyConfig) => Promise<any>;
    proxyPing: (config: ProxyConfig) => Promise<any>;
    proxyByName: (name: string) => Promise<any>;
    webrtcLeak: (config: ProxyConfig) => Promise<any>;
  };
  storage: {
    info: () => Promise<any>;
    clearCache: (dirId?: string) => Promise<any>;
    availableDisk: () => Promise<any>;
  };
  sync: {
    push: () => Promise<any>;
    pull: () => Promise<any>;
    status: () => Promise<any>;
    preview: () => Promise<{ configured: boolean; profiles: number; runningProfiles: string[]; proxies: number; accounts: number; extensions: number; message: string }>;
    configure: (config: any) => Promise<any>;
  };
  app: {
    paths: () => Promise<any>;
    reloadConfig: () => Promise<any>;
    openDir: (dirPath: string) => Promise<any>;
    version: () => Promise<string>;
    openUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
    setLanguage: (lang: string) => Promise<{ success: boolean; language: string }>;
    getLanguage: () => Promise<{ language: string }>;
  };
  settings: {
    extensions: (dirId: string) => Promise<Array<ExtensionRepositoryEntry & { enabled: boolean }>>;
    extensionRepository: (filter?: string) => Promise<ExtensionRepositoryEntry[]>;
    addRepositoryExtension: (extId: string, options?: { shared?: boolean; tags?: string[] }) => Promise<{ success: boolean; entry?: ExtensionRepositoryEntry; error?: string }>;
    updateRepositoryExtension: (extId: string) => Promise<{ success: boolean; entry?: ExtensionRepositoryEntry; error?: string }>;
    deleteRepositoryExtension: (extId: string) => Promise<{ success: boolean; error?: string }>;
    setRepositoryExtensionMeta: (extId: string, meta: { shared?: boolean; tags?: string[] }) => Promise<{ success: boolean; entry?: ExtensionRepositoryEntry; error?: string }>;
    exportSharedExtensionRepository: () => Promise<Array<Pick<ExtensionRepositoryEntry, "id" | "name" | "version" | "description" | "source" | "chromeStoreUrl" | "shared" | "tags">>>;
    deleteExtension: (dirId: string, extId: string) => Promise<{ success: boolean }>;
    installExtension: (dirId: string, extId: string) => Promise<{ success: boolean; error?: string }>;
    toggleExtension: (dirId: string, extId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    checkExtensionUpdate: (dirId: string, extId: string) => Promise<any>;
    pickExtensionFile: () => Promise<string | null>;
    profileExtensions: (dirId: string) => Promise<Record<string, boolean>>;
    setProfileExtensions: (dirId: string, extensions: Record<string, boolean>) => Promise<{ success: boolean; error?: string }>;
    bookmarks: (dirId: string) => Promise<any>;
    addBookmark: (dirId: string, url: string, name: string) => Promise<{ success: boolean }>;
    writeBookmarks: (dirId: string, bookmarks: any) => Promise<{ success: boolean }>;
    preferences: (dirId: string) => Promise<any>;
    updatePreferences: (dirId: string, prefs: any) => Promise<{ success: boolean }>;
    applyProfile: (dirId: string, settings: any) => Promise<{ success: boolean }>;
  };
  mcp: {
    status: () => Promise<any>;
    restart: () => Promise<any>;
    revealToken: () => Promise<{ token: string | null }>;
  };
  browser: {
    list: () => Promise<BrowserProfileInfo[]>;
    binary: () => Promise<ManagedChromiumStatus>;
    verifyBinary: () => Promise<{ success: boolean; status: ManagedChromiumStatus; error?: string }>;
    create: (opts: any) => Promise<{ dirId: string }>;
    delete: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    launch: (dirId: string) => Promise<{ success: boolean; pid?: number; cdpPort?: number; error?: string }>;
    stop: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    status: (dirId: string) => Promise<any>;
    setSeed: (dirId: string, seed: number) => Promise<{ success: boolean }>;
    setMeta: (dirId: string, meta: any) => Promise<{ success: boolean }>;
    openRiskCheck: (dirId: string) => Promise<{ success: boolean; error?: string }>;
  };
  agent: {
    llmConfig: () => Promise<RedactedLlmConfig | null>;
    detectLlmConfig: () => Promise<RedactedLlmConfig | null>;
    saveLlmConfig: (config: { provider: "openai" | "claude" | "custom"; apiKey?: string; apiUrl?: string; model?: string }) => Promise<{ success: boolean; error?: string }>;
    chat: (conversationId: string, message: string) => Promise<any>;
    chatStream: (conversationId: string, message: string, streamId?: string) => Promise<any>;
    chatSimple: (messages: Array<{ role: string; content: string }>) => Promise<any>;
    listSkills: () => Promise<SkillRepositoryEntry[]>;
    taskTemplates: () => Promise<Array<{ id: string; title: string; category: string; description: string; riskLevel: string; requiredInputs: any[]; tools: string[]; successCriteria: string[]; examplePrompt: string; prompt: string; steps: string[]; outputTable?: { name: string; columns: string[] } }>>;
    skills: {
      list: (filter?: string) => Promise<SkillRepositoryEntry[]>;
      marketplace: (filter?: string) => Promise<SkillRepositoryEntry[]>;
      add: (skill: Partial<SkillRepositoryEntry> & { id: string; prompt: string }) => Promise<{ success: boolean; skill?: SkillRepositoryEntry; error?: string }>;
      install: (id: string) => Promise<{ success: boolean; skill?: SkillRepositoryEntry; error?: string }>;
      remove: (id: string) => Promise<{ success: boolean; error?: string }>;
      setMeta: (id: string, meta: { shared?: boolean; enabled?: boolean; tags?: string[] }) => Promise<{ success: boolean; skill?: SkillRepositoryEntry; error?: string }>;
      exportShared: () => Promise<Array<Pick<SkillRepositoryEntry, "id" | "name" | "title" | "version" | "description" | "source" | "tools" | "prompt" | "shared" | "tags" | "author" | "homepage">>>;
      importShared: (entries: any[]) => Promise<{ success: boolean; result?: { added: number; updated: number; skipped: number }; error?: string }>;
    };
    conversations: any;
    accounts: {
      list: () => Promise<RedactedPlatformAccount[]>;
      add: (account: { platformUrl: string; platformUserName: string; platformPassword: string; profileIds?: string[]; tags?: string[] }) => Promise<any>;
      update: (index: number, account: Partial<{ platformUrl: string; platformUserName: string; platformPassword: string; profileIds: string[]; tags: string[] }>) => Promise<any>;
      delete: (index: number) => Promise<boolean>;
      forProfile: (dirId: string) => Promise<RedactedPlatformAccount[]>;
    };
  };
  on: (channel: string, callback: (...args: any[]) => void) => void;
  removeListener: (channel: string, callback: (...args: any[]) => void) => void;
}

declare global {
  interface Window {
    agentBrowserAPI?: AgentBrowserAPI;
    agentBrowser?: any;
  }
}

export {};
