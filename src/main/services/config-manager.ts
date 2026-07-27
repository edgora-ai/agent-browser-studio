import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { app } from "electron";
import { validateDirId } from "./utils.js";
import { encryptSecret, isEncrypted, decryptSecretOr, usingEncryption } from "./secrets.js";
import type { MgmtConfig, ProxyConfig, ProxyDetectionCacheEntry, CloakProfileMeta, ProxyMode, ResolvedProfileProxy, ExtensionRepositoryEntry, SkillRepositoryEntry, SkillCatalogSource, LlmConfig, PlatformAccount, AutomationRule, AutomationTrigger, AutomationAction, AutomationTriggerType, AutomationActionType, AgentRun, AgentRunStep, AgentRunSource, AgentRunStatus, AgentFsConfig, AgentFsMode } from "../types.js";

// ── Paths (lazy — resolved on first access so app.setName() can run first) ──
let _appDataDir: string | null = null;
let _configPath: string | null = null;
let _profilesDir: string | null = null;

function resolveAppDataDir(): string {
  if (!_appDataDir) {
    _appDataDir = app.getPath("userData");
  }
  return _appDataDir;
}

// ── Defaults ──
const DefaultProxy: ProxyConfig = {
  type: "http",
  host: "127.0.0.1",
  port: 7890,
};

const DefaultConfig: MgmtConfig = {
  version: 3,
  cloakBin: "auto",
  defaultProxy: "default",
  proxies: {
    "default": { ...DefaultProxy },
  },
  proxyDetections: {},
  sync: {
    enabled: false,
    endpoint: "",
    bucket: "",
    accessKey: "",
    secretKey: "",
  },
  cloakProfiles: {},
  extensionRepository: {},
  skillRepository: {},
  skillCatalogSources: [],
  automation: [],
  agentRuns: [],
  agentFs: { mode: "sandbox", allowlist: [] },
};

// ── In-memory config cache ──
let config: MgmtConfig | null = null;

// ── Public API ──

export function getConfig(): MgmtConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

export function getConfigPath(): string {
  if (!_configPath) _configPath = path.join(resolveAppDataDir(), "config.json");
  return _configPath;
}

export function getAppDataDir(): string {
  return resolveAppDataDir();
}

export function getProfilesDir(): string {
  if (!_profilesDir) _profilesDir = path.join(resolveAppDataDir(), "cloak-profiles");
  return _profilesDir;
}

// ── Proxy management ──

export function getProxyList(): Array<{ name: string; config: ProxyConfig & { hasAuth?: boolean }; isDefault: boolean }> {
  const cfg = getConfig();
  return Object.entries(cfg.proxies).map(([name, c]) => ({
    name,
    config: redactProxyConfig(c),
    isDefault: name === cfg.defaultProxy,
  }));
}

export function getProxy(name: string): (ProxyConfig & { hasAuth?: boolean }) | null {
  if (!isValidProxyName(name)) return null;
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.proxies, name)) return null;
  return redactProxyConfig(cfg.proxies[name]);
}

export function getProxySecret(name: string): ProxyConfig | null {
  if (!isValidProxyName(name)) return null;
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.proxies, name)) return null;
  const proxy = cfg.proxies[name];
  return proxy.username && proxy.password
    ? { ...proxy, password: decryptSecretOr(proxy.password) }
    : { ...proxy };
}

export function getProxyDetection(name: string): ProxyDetectionCacheEntry | null {
  if (!isValidProxyName(name)) return null;
  const cfg = getConfig();
  return cfg.proxyDetections && Object.hasOwn(cfg.proxyDetections, name) ? cfg.proxyDetections[name] : null;
}

export function setProxyDetection(name: string, entry: ProxyDetectionCacheEntry): void {
  validateProxyName(name);
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.proxies, name)) throw new Error(`Proxy not found: ${name}`);
  cfg.proxyDetections = cfg.proxyDetections || {};
  cfg.proxyDetections[name] = normalizeProxyDetection(entry);
  saveConfig(cfg);
}

export function setProxyDetectionIfCurrent(name: string, expectedConfig: ProxyConfig, entry: ProxyDetectionCacheEntry): boolean {
  validateProxyName(name);
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.proxies, name)) return false;
  if (!proxyConfigEquivalent(cfg.proxies[name], normalizeProxyConfig(expectedConfig, cfg.proxies[name]))) return false;
  cfg.proxyDetections = cfg.proxyDetections || {};
  cfg.proxyDetections[name] = normalizeProxyDetection(entry);
  saveConfig(cfg);
  return true;
}

export function addProxy(name: string, config: ProxyConfig): void {
  validateProxyName(name);
  const cfg = getConfig();
  cfg.proxies[name] = normalizeProxyConfig(config);
  if (cfg.proxyDetections) delete cfg.proxyDetections[name];
  saveConfig(cfg);
}

export function renameProxy(oldName: string, newName: string, config: ProxyConfig): boolean {
  validateProxyName(oldName);
  validateProxyName(newName);
  const cfg = getConfig();
  if (oldName === "default") throw new Error("Default proxy cannot be renamed");
  if (!Object.hasOwn(cfg.proxies, oldName)) return false;
  if (oldName !== newName && Object.hasOwn(cfg.proxies, newName)) throw new Error(`Proxy already exists: ${newName}`);

  const previous = cfg.proxies[oldName];
  const normalized = normalizeProxyConfig(config, previous);
  cfg.proxies[newName] = normalized;

  if (oldName === newName) {
    if (cfg.proxyDetections && Object.hasOwn(cfg.proxyDetections, oldName) && !proxyConfigEquivalent(previous, normalized)) {
      delete cfg.proxyDetections[oldName];
    }
  } else {
    delete cfg.proxies[oldName];
    if (cfg.proxyDetections && Object.hasOwn(cfg.proxyDetections, oldName)) {
      if (proxyConfigEquivalent(previous, normalized)) cfg.proxyDetections[newName] = cfg.proxyDetections[oldName];
      delete cfg.proxyDetections[oldName];
    }
    if (cfg.defaultProxy === oldName) cfg.defaultProxy = newName;
    for (const profile of Object.values(cfg.cloakProfiles || {})) {
      if (profile.proxyMode === "named" && profile.proxyName === oldName) {
        profile.proxyName = newName;
      }
    }
  }

  saveConfig(cfg);
  return true;
}

/**
 * One-time migration: encrypt any plaintext secrets already sitting in config
 * (existing users with plaintext llm key / proxy password / account password /
 * sync secret). Safe on every startup — no-op once encrypted, and no-op when
 * the OS keychain isn't available. Returns how many fields were migrated.
 */
export function migrateSecrets(): number {
  if (!usingEncryption()) return 0;
  const cfg = getConfig();
  let changed = 0;
  if (cfg.llm?.apiKey && !isEncrypted(cfg.llm.apiKey)) { cfg.llm.apiKey = encryptSecret(cfg.llm.apiKey); changed++; }
  if (cfg.sync?.secretKey && !isEncrypted(cfg.sync.secretKey)) { cfg.sync.secretKey = encryptSecret(cfg.sync.secretKey); changed++; }
  for (const proxy of Object.values(cfg.proxies || {})) {
    if (proxy.username && proxy.password && !isEncrypted(proxy.password)) {
      proxy.password = encryptSecret(proxy.password);
      changed++;
    }
  }
  for (const acc of cfg.accounts || []) {
    if (acc.platformPassword && !isEncrypted(acc.platformPassword)) {
      acc.platformPassword = encryptSecret(acc.platformPassword);
      changed++;
    }
  }
  if (changed > 0) saveConfig(cfg);
  return changed;
}

export function deleteProxy(name: string): boolean {
  validateProxyName(name);
  const cfg = getConfig();
  if (name === "default") return false;
  if (!Object.hasOwn(cfg.proxies, name)) return false;

  for (const p of Object.values(cfg.cloakProfiles || {})) {
    if (p.proxyMode === "named" && p.proxyName === name) {
      return false;
    }
  }

  delete cfg.proxies[name];
  if (cfg.proxyDetections) delete cfg.proxyDetections[name];

  if (cfg.defaultProxy === name) {
    cfg.defaultProxy = "default";
  }

  saveConfig(cfg);
  return true;
}

export function setDefaultProxyName(name: string): boolean {
  validateProxyName(name);
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.proxies, name)) return false;
  cfg.defaultProxy = name;
  saveConfig(cfg);
  return true;
}

export function updateProxy(name: string, config: ProxyConfig): boolean {
  validateProxyName(name);
  const cfg = getConfig();
  if (!Object.hasOwn(cfg.proxies, name)) return false;
  const previous = cfg.proxies[name];
  const normalized = normalizeProxyConfig(config, previous);
  cfg.proxies[name] = normalized;
  if (cfg.proxyDetections && !proxyConfigEquivalent(previous, normalized)) delete cfg.proxyDetections[name];
  saveConfig(cfg);
  return true;
}

export function resolveProfileProxy(dirId: string): ResolvedProfileProxy {
  return resolveProfileProxyInternal(dirId, true);
}

export function resolveProfileProxySecret(dirId: string): ResolvedProfileProxy {
  return resolveProfileProxyInternal(dirId, false);
}

function resolveProfileProxyInternal(dirId: string, redact: boolean): ResolvedProfileProxy {
  validateDirId(dirId);
  const cfg = getConfig();
  const meta = Object.hasOwn(cfg.cloakProfiles || {}, dirId) ? cfg.cloakProfiles[dirId] : undefined;
  const mode = normalizeProxyMode(meta?.proxyMode, meta?.proxyName ?? null);

  if (mode === "none") {
    return { mode, name: null, config: null };
  }

  const proxyName = mode === "default" ? cfg.defaultProxy : (meta?.proxyName || null);
  if (!proxyName) {
    return { mode: "none", name: null, config: null };
  }

  if (!Object.hasOwn(cfg.proxies, proxyName)) {
    return { mode, name: proxyName, config: null };
  }
  const proxy = cfg.proxies[proxyName];

  // Decrypt the password for consumers that actually use it (browser launch);
  // redacted path strips it entirely.
  const usableConfig = proxy.username && proxy.password
    ? { ...proxy, password: decryptSecretOr(proxy.password) }
    : { ...proxy };
  return { mode, name: proxyName, config: redact ? redactProxyConfig(proxy) : usableConfig };
}

function redactProxyConfig(proxy: ProxyConfig): ProxyConfig & { hasAuth?: boolean } {
  const { password: _password, ...safe } = proxy;
  return {
    ...safe,
    ...(proxy.username ? { hasAuth: true } : {}),
  };
}

export function getProfileProxy(dirId: string): ProxyConfig | null {
  return resolveProfileProxy(dirId).config;
}

export function getProfileProxyName(dirId: string): string | null {
  return resolveProfileProxy(dirId).name;
}

export function getProfileProxyMode(dirId: string): ProxyMode {
  return resolveProfileProxy(dirId).mode;
}

export function setProfileProxy(dirId: string, proxyName: string | null, mode?: ProxyMode): void {
  const cfg = getConfig();
  setProfileProxyOnConfig(cfg, dirId, proxyName, mode);
  saveConfig(cfg);
}

export function setProfileProxyOnConfig(cfg: MgmtConfig, dirId: string, proxyName: string | null, mode?: ProxyMode): void {
  validateDirId(dirId);
  const cp = cfg.cloakProfiles || {};
  if (!Object.hasOwn(cp, dirId)) throw new Error(`Profile not found: ${dirId}`);
  const nextMode = normalizeProxyMode(mode, proxyName);
  if (nextMode === "named") {
    if (!proxyName) throw new Error("Named proxy mode requires a proxy name");
    validateProxyName(proxyName);
    if (!Object.hasOwn(cfg.proxies, proxyName)) throw new Error(`Proxy not found: ${proxyName}`);
  }
  cp[dirId].proxyMode = nextMode;
  cp[dirId].proxyName = nextMode === "named" ? proxyName : null;
  cfg.cloakProfiles = cp;
}

function normalizeProxyMode(mode: ProxyMode | undefined, proxyName: string | null, legacyDefault = false): ProxyMode {
  if (mode === "none" || mode === "default" || mode === "named") return mode;
  if (mode !== undefined) throw new Error(`Invalid proxy mode: ${JSON.stringify(mode)}`);
  if (proxyName) return "named";
  return legacyDefault ? "default" : "none";
}

function isValidProxyName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) && name !== "__proto__" && name !== "prototype" && name !== "constructor";
}

function validateProxyName(name: string): void {
  if (!isValidProxyName(name)) {
    throw new Error(`Invalid proxy name: ${JSON.stringify(name)}`);
  }
}

function sanitizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid fingerprint text value");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error("Invalid fingerprint text value");
  return trimmed;
}

function sanitizeOptionalFontsDir(value: unknown): string | null {
  const fontsDir = sanitizeOptionalText(value, 500);
  if (!fontsDir) return null;
  const resolved = path.resolve(fontsDir);
  const allowedRoot = path.join(getAppDataDir(), "fonts");
  const realRoot = fs.existsSync(allowedRoot) ? fs.realpathSync(allowedRoot) : allowedRoot;
  const realDir = fs.realpathSync(resolved);
  if (!path.isAbsolute(fontsDir) || !fs.lstatSync(resolved).isDirectory() || !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`Fonts directory must be inside ${allowedRoot}`);
  }
  return realDir;
}

function sanitizeFingerprintSeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999999) throw new Error(`Invalid fingerprint seed: ${JSON.stringify(value)}`);
  return n;
}

function sanitizeCloakPlatform(value: unknown): "windows" | "macos" {
  if (value === "windows" || value === "macos") return value;
  throw new Error(`Invalid Cloak platform: ${JSON.stringify(value)}`);
}

function sanitizeOptionalLocale(value: unknown): string | null {
  const locale = sanitizeOptionalText(value, 35);
  if (!locale) return null;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    throw new Error(`Invalid locale: ${JSON.stringify(value)}`);
  }
}

function sanitizeOptionalTimezone(value: unknown): string | null {
  const timezone = sanitizeOptionalText(value, 80);
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    throw new Error(`Invalid timezone: ${JSON.stringify(value)}`);
  }
}

function sanitizeOptionalIp(value: unknown): string | null {
  const ip = sanitizeOptionalText(value, 45);
  if (!ip) return null;
  if (!net.isIP(ip)) throw new Error(`Invalid WebRTC IP: ${JSON.stringify(value)}`);
  return ip;
}

function sanitizeOptionalInteger(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid fingerprint integer value: ${JSON.stringify(value)}`);
  return n;
}

function normalizeExtensionMap(value: Record<string, boolean> | undefined): Record<string, boolean> {
  const normalized: Record<string, boolean> = Object.create(null);
  if (!value) return normalized;
  for (const [extId, enabled] of Object.entries(value)) {
    if (!/^(?:[a-p]{32}|local_[a-z0-9]{8,40})$/.test(extId) || extId === "__proto__" || extId === "prototype" || extId === "constructor") {
      throw new Error(`Invalid extension ID: ${JSON.stringify(extId)}`);
    }
    if (typeof enabled !== "boolean") throw new Error(`Invalid extension enabled flag for ${extId}`);
    normalized[extId] = enabled;
  }
  return normalized;
}

export function normalizeProfileExtensionMap(value: Record<string, boolean> | undefined): Record<string, boolean> {
  return normalizeExtensionMap(value);
}

function normalizeExtensionRepository(
  value: Record<string, ExtensionRepositoryEntry> | undefined,
  options: { relocateStoredPaths?: boolean; skipInvalidEntries?: boolean } = {},
): Record<string, ExtensionRepositoryEntry> {
  const normalized: Record<string, ExtensionRepositoryEntry> = Object.create(null);
  if (!value) return normalized;
  const appDataDir = getAppDataDir();
  const repoRoot = path.resolve(appDataDir, "extension-repository");
  for (const [extId, rawEntry] of Object.entries(value)) {
    try {
      if (!/^(?:[a-p]{32}|local_[a-z0-9]{8,40})$/.test(extId) || extId !== rawEntry?.id) {
        throw new Error(`Invalid extension repository ID: ${JSON.stringify(extId)}`);
      }
      const unpackedPath = sanitizeOptionalText(rawEntry.unpackedPath, 700);
      if (!unpackedPath) throw new Error(`Extension repository entry missing unpackedPath: ${extId}`);
      const storedPath = path.resolve(unpackedPath);
      const expectedPath = path.join(repoRoot, extId, "current");
      const resolvedPath = options.relocateStoredPaths ? expectedPath : storedPath;
      if (storedPath !== expectedPath && !options.relocateStoredPaths) {
        throw new Error(`Extension repository path is not canonical: ${extId}`);
      }
      if (fs.existsSync(resolvedPath)) {
        if (!isRealDirectoryInside(repoRoot, getAppDataDir()) || !isRealDirectoryInside(path.dirname(resolvedPath), repoRoot) || !isRealDirectoryInside(resolvedPath, path.dirname(resolvedPath))) {
          throw new Error(`Extension repository path is not a real directory: ${extId}`);
        }
      }
      const source = rawEntry.source === "chrome-web-store" || rawEntry.source === "local" ? rawEntry.source : null;
      if (!source) throw new Error(`Invalid extension repository source: ${extId}`);
      normalized[extId] = {
        id: extId,
        name: sanitizeOptionalText(rawEntry.name, 120) || extId,
        version: sanitizeOptionalText(rawEntry.version, 80) || "?",
        description: sanitizeOptionalText(rawEntry.description, 500) || "",
        source,
        chromeStoreUrl: source === "local" ? undefined : sanitizeChromeStoreUrl(rawEntry.chromeStoreUrl, extId),
        updateUrl: source === "local" ? undefined : sanitizeChromeUpdateUrl(rawEntry.updateUrl, extId),
        unpackedPath: resolvedPath,
        packageHash: sanitizeHexHash(rawEntry.packageHash),
        manifestHash: sanitizeHexHash(rawEntry.manifestHash),
        shared: Boolean(rawEntry.shared),
        tags: normalizeExtensionTags(rawEntry.tags),
        addedAt: sanitizeTimestamp(rawEntry.addedAt),
        updatedAt: sanitizeTimestamp(rawEntry.updatedAt),
      };
    } catch (error) {
      if (!options.skipInvalidEntries) throw error;
      console.error(`Invalid extension repository entry ignored while loading config: ${extId}`, error);
    }
  }
  return normalized;
}

function normalizeExtensionTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => sanitizeOptionalText(entry, 40)).filter((entry): entry is string => Boolean(entry)))].slice(0, 20);
}

function normalizeProfileTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => sanitizeOptionalText(entry, 40)).filter((entry): entry is string => Boolean(entry)))].slice(0, 20);
}

function sanitizeHexHash(value: unknown): string {
  const hash = sanitizeOptionalText(value, 128);
  if (!hash || !/^[a-f0-9]{128}$/i.test(hash)) throw new Error("Invalid extension hash");
  return hash.toLowerCase();
}

function sanitizeTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) return Date.now();
  return Math.floor(timestamp);
}

function sanitizeChromeStoreUrl(value: unknown, extId: string): string {
  const url = sanitizeOptionalText(value, 500) || `https://chromewebstore.google.com/detail/${extId}`;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "chromewebstore.google.com" || !parsed.pathname.includes(extId)) {
    throw new Error(`Invalid Chrome Web Store URL for ${extId}`);
  }
  return parsed.toString();
}

function sanitizeChromeUpdateUrl(value: unknown, extId: string): string {
  const url = sanitizeOptionalText(value, 1000);
  if (!url) throw new Error(`Missing Chrome update URL for ${extId}`);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "clients2.google.com" || !parsed.search.includes(extId)) {
    throw new Error(`Invalid Chrome update URL for ${extId}`);
  }
  return parsed.toString();
}

function normalizeSkillRepository(value: Record<string, SkillRepositoryEntry> | undefined): Record<string, SkillRepositoryEntry> {
  const normalized: Record<string, SkillRepositoryEntry> = Object.create(null);
  if (!value) return normalized;
  for (const [id, rawEntry] of Object.entries(value)) {
    validateSkillId(id);
    if (id !== rawEntry?.id) throw new Error(`Invalid skill repository ID: ${JSON.stringify(id)}`);
    normalized[id] = normalizeSkillEntry(rawEntry);
  }
  return normalized;
}

function normalizeSkillEntry(rawEntry: SkillRepositoryEntry): SkillRepositoryEntry {
  validateSkillId(rawEntry.id);
  const source = rawEntry.source === "built-in" || rawEntry.source === "local" || rawEntry.source === "shared-catalog" ? rawEntry.source : null;
  if (!source) throw new Error(`Invalid skill source: ${rawEntry.id}`);
  return {
    id: rawEntry.id,
    name: sanitizeOptionalText(rawEntry.name, 80) || rawEntry.id,
    title: sanitizeOptionalText(rawEntry.title, 120) || rawEntry.name || rawEntry.id,
    version: sanitizeOptionalText(rawEntry.version, 40) || "1.0.0",
    description: sanitizeOptionalText(rawEntry.description, 500) || "",
    source,
    tools: normalizeSkillTools(rawEntry.tools),
    prompt: sanitizeRequiredSkillPrompt(rawEntry.prompt),
    shared: Boolean(rawEntry.shared),
    enabled: Boolean(rawEntry.enabled),
    tags: normalizeExtensionTags(rawEntry.tags),
    author: sanitizeOptionalText(rawEntry.author, 120) || undefined,
    homepage: sanitizeOptionalHomepage(rawEntry.homepage),
    packageHash: rawEntry.packageHash ? sanitizeHexHash(rawEntry.packageHash) : undefined,
    addedAt: sanitizeTimestamp(rawEntry.addedAt),
    updatedAt: sanitizeTimestamp(rawEntry.updatedAt),
  };
}

function normalizeSkillCatalogSources(value: unknown): SkillCatalogSource[] {
  if (!Array.isArray(value)) return [];
  return value.map((source) => {
    const raw = source as SkillCatalogSource;
    validateSkillId(raw.id);
    return {
      id: raw.id,
      name: sanitizeOptionalText(raw.name, 120) || raw.id,
      url: sanitizeOptionalHomepage(raw.url),
      enabled: raw.enabled !== false,
      addedAt: sanitizeTimestamp(raw.addedAt),
    };
  }).slice(0, 20);
}

function validateSkillId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || id === "__proto__" || id === "constructor" || id === "prototype") {
    throw new Error(`Invalid skill ID: ${JSON.stringify(id)}`);
  }
}

function normalizeSkillTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tool) => sanitizeOptionalText(tool, 80)).filter((tool): tool is string => Boolean(tool)))].slice(0, 50);
}

function sanitizeRequiredSkillPrompt(value: unknown): string {
  if (value === undefined || value === null || value === "") throw new Error("Skill prompt is required");
  if (typeof value !== "string") throw new Error("Invalid skill prompt value");
  const prompt = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, 12000);
  if (!prompt) throw new Error("Skill prompt is required");
  return prompt;
}

function sanitizeOptionalHomepage(value: unknown): string | undefined {
  const url = sanitizeOptionalText(value, 500);
  if (!url) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Skill URL must use HTTPS");
  return parsed.toString();
}

function isPathInside(childPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRealDirectoryInside(candidate: string, parent: string): boolean {
  if (!fs.existsSync(candidate) || !fs.existsSync(parent)) return false;
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
  return isPathInside(fs.realpathSync(candidate), fs.realpathSync(parent));
}

function proxyConfigEquivalent(a: ProxyConfig | undefined, b: ProxyConfig | undefined): boolean {
  if (!a || !b) return false;
  const bypassA = [...(a.bypassList || [])].sort();
  const bypassB = [...(b.bypassList || [])].sort();
  return a.type === b.type && a.host === b.host && a.port === b.port &&
    (a.username || "") === (b.username || "") && comparableProxyPassword(a.password) === comparableProxyPassword(b.password) &&
    bypassA.length === bypassB.length && bypassA.every((entry, index) => entry === bypassB[index]);
}

function comparableProxyPassword(value: string | undefined): string {
  if (!value) return "";
  if (!isEncrypted(value)) return value;
  const decrypted = decryptSecretOr(value, "");
  return decrypted || value;
}

function normalizeProxyDetection(entry: ProxyDetectionCacheEntry): ProxyDetectionCacheEntry {
  return {
    detectedAt: sanitizeTimestamp(entry.detectedAt),
    success: Boolean(entry.success),
    exitIp: sanitizeOptionalText(entry.exitIp, 80),
    country: sanitizeOptionalText(entry.country, 120),
    countryCode: sanitizeOptionalText(entry.countryCode, 8),
    timezone: sanitizeOptionalText(entry.timezone, 80),
    provider: sanitizeOptionalText(entry.provider, 80),
    latencyMs: typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs) ? Math.max(0, Math.floor(entry.latencyMs)) : null,
    error: sanitizeOptionalText(entry.error, 500),
  };
}

function normalizeProxyDetections(value: Record<string, ProxyDetectionCacheEntry> | undefined, proxies: Record<string, ProxyConfig>): Record<string, ProxyDetectionCacheEntry> {
  const normalized: Record<string, ProxyDetectionCacheEntry> = Object.create(null);
  if (!value) return normalized;
  for (const [name, entry] of Object.entries(value)) {
    if (!isValidProxyName(name) || !Object.hasOwn(proxies, name)) continue;
    try {
      normalized[name] = normalizeProxyDetection(entry);
    } catch (e) {
      console.warn(`Ignoring invalid proxy detection cache entry for ${name}:`, e);
    }
  }
  return normalized;
}

function normalizeProxyConfig(config: ProxyConfig, previous?: ProxyConfig): ProxyConfig {
  if (!config || (config.type !== "http" && config.type !== "socks5" && config.type !== "socks5h")) {
    throw new Error(`Invalid proxy type: ${JSON.stringify(config?.type)}`);
  }
  const host = normalizeProxyHost(config.host);
  const port = typeof config.port === "number" ? config.port : Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid proxy port: ${JSON.stringify(config.port)}`);

  const username = config.username?.trim() || undefined;
  let password = username ? (config.password === undefined && previous?.username === username ? previous.password : config.password || "") : undefined;
  // Encrypt the password at rest (passthrough when safeStorage unavailable).
  if (password && !isEncrypted(password)) password = encryptSecret(password);
  const bypassList = normalizeBypassList(config.bypassList);
  return {
    type: config.type,
    host,
    port,
    ...(username ? { username, password } : {}),
    ...(bypassList.length ? { bypassList } : {}),
  };
}

function normalizeProxyHost(value: unknown): string {
  const host = String(value || "").trim();
  const isIp = net.isIP(host) !== 0;
  const isHostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/.test(host);
  if (!isIp && !isHostname) {
    throw new Error(`Invalid proxy host: ${JSON.stringify(value)}`);
  }
  return host;
}

function normalizeBypassList(value: string[] | undefined): string[] {
  if (!value) return [];
  return value.map((entry) => String(entry || "").trim()).filter(Boolean).map((entry) => {
    validateProxyBypassEntry(entry);
    return entry;
  });
}

function validateProxyBypassEntry(entry: string): void {
  if (entry === "*" || /^<local>$/i.test(entry)) throw new Error(`Unsafe proxy bypass entry: ${entry}`);
  if (!/^[A-Za-z0-9*_.:\/-]{1,253}$/.test(entry)) throw new Error(`Invalid proxy bypass entry: ${entry}`);
  if (isUnsafeBypassPattern(entry)) throw new Error(`Unsafe proxy bypass entry: ${entry}`);

  const stripped = entry.replace(/^\*\./, "");
  const urlCandidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(stripped) ? stripped : `http://${stripped}`;
  let host = "";
  try {
    host = new URL(urlCandidate).hostname;
  } catch {
    throw new Error(`Invalid proxy bypass entry: ${entry}`);
  }
  host = host.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (!host) throw new Error(`Invalid proxy bypass entry: ${entry}`);
  if (isUnsafeBypassHost(host)) throw new Error(`Unsafe proxy bypass entry: ${entry}`);
}

function isUnsafeBypassPattern(entry: string): boolean {
  const hostPart = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\*\./, "").split("/", 1)[0].replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (/^(localhost|.*\.localhost)(?::\d+)?$/.test(hostPart)) return true;
  if (/^(::1|::|fe80:|fc|fd)/.test(hostPart)) return true;
  if (hostPart.includes("*")) {
    const stripped = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/", 1)[0].toLowerCase();
    if (!/^\*\.[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/.test(stripped)) return true;
    if (stripped.endsWith(".local") || stripped.endsWith(".localhost")) return true;
  }
  return false;
}

function isUnsafeBypassHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return false;
}

// ── Profile metadata ──

export function getProfileMeta(dirId: string): CloakProfileMeta | null {
  validateDirId(dirId);
  const cfg = getConfig();
  const cp = Object.hasOwn(cfg.cloakProfiles || {}, dirId) ? cfg.cloakProfiles[dirId] : undefined;
  if (!cp) return null;
  return {
    name: cp.name,
    proxyMode: normalizeProxyMode(cp.proxyMode, cp.proxyName || null),
    proxyName: cp.proxyName || null,
    syncedAt: cp.syncedAt,
    syncedHash: cp.syncedHash,
    note: cp.note || null,
    tags: normalizeProfileTags(cp.tags),
    platform: cp.platform === "macos" ? "macos" : "windows",
    timezone: sanitizeOptionalTimezone(cp.timezone),
    locale: sanitizeOptionalLocale(cp.locale),
    webrtcIp: sanitizeOptionalIp(cp.webrtcIp),
    fingerprintSeed: sanitizeFingerprintSeed(cp.fingerprintSeed || 12345),
    gpuVendor: sanitizeOptionalText(cp.gpuVendor, 80),
    gpuRenderer: sanitizeOptionalText(cp.gpuRenderer, 160),
    hardwareConcurrency: sanitizeOptionalInteger(cp.hardwareConcurrency, 1, 64),
    deviceMemory: sanitizeOptionalInteger(cp.deviceMemory, 1, 128),
    screenWidth: sanitizeOptionalInteger(cp.screenWidth, 320, 10000),
    screenHeight: sanitizeOptionalInteger(cp.screenHeight, 240, 10000),
    storageQuota: sanitizeOptionalInteger(cp.storageQuota, 1, 1048576),
    taskbarHeight: sanitizeOptionalInteger(cp.taskbarHeight, 0, 500),
    fontsDir: sanitizeOptionalFontsDir(cp.fontsDir),
    extensions: normalizeExtensionMap(cp.extensions),
  };
}

export function setProfileMeta(dirId: string, meta: Partial<CloakProfileMeta>): void {
  validateDirId(dirId);
  const cfg = structuredClone(getConfig());
  const cp = cfg.cloakProfiles || {};
  const current = Object.hasOwn(cp, dirId) ? cp[dirId] : { name: dirId.substring(0, 8), fingerprintSeed: 12345 };
  const next: CloakProfileMeta = { ...current };

  if (meta.proxyMode !== undefined || meta.proxyName !== undefined) {
    const nextMode = normalizeProxyMode(meta.proxyMode, meta.proxyName ?? next.proxyName ?? null);
    if (nextMode === "named") {
      const proxyName = meta.proxyName ?? next.proxyName ?? null;
      if (!proxyName) throw new Error("Named proxy mode requires a proxy name");
      validateProxyName(proxyName);
      if (!Object.hasOwn(cfg.proxies, proxyName)) throw new Error(`Proxy not found: ${proxyName}`);
      next.proxyName = proxyName;
    } else {
      next.proxyName = null;
    }
    next.proxyMode = nextMode;
  }

  if (meta.name !== undefined) next.name = meta.name;
  if (meta.note !== undefined) next.note = meta.note || null;
  if (meta.tags !== undefined) next.tags = normalizeProfileTags(meta.tags);
  if (meta.syncedAt !== undefined) next.syncedAt = meta.syncedAt;
  if (meta.syncedHash !== undefined) next.syncedHash = meta.syncedHash;
  if (meta.platform !== undefined) next.platform = sanitizeCloakPlatform(meta.platform);
  if (meta.timezone !== undefined) next.timezone = sanitizeOptionalTimezone(meta.timezone);
  if (meta.locale !== undefined) next.locale = sanitizeOptionalLocale(meta.locale);
  if (meta.webrtcIp !== undefined) next.webrtcIp = sanitizeOptionalIp(meta.webrtcIp);
  if (meta.fingerprintSeed !== undefined) next.fingerprintSeed = sanitizeFingerprintSeed(meta.fingerprintSeed);
  if (meta.gpuVendor !== undefined) next.gpuVendor = sanitizeOptionalText(meta.gpuVendor, 80);
  if (meta.gpuRenderer !== undefined) next.gpuRenderer = sanitizeOptionalText(meta.gpuRenderer, 160);
  if (meta.hardwareConcurrency !== undefined) next.hardwareConcurrency = sanitizeOptionalInteger(meta.hardwareConcurrency, 1, 64);
  if (meta.deviceMemory !== undefined) next.deviceMemory = sanitizeOptionalInteger(meta.deviceMemory, 1, 128);
  if (meta.screenWidth !== undefined) next.screenWidth = sanitizeOptionalInteger(meta.screenWidth, 320, 10000);
  if (meta.screenHeight !== undefined) next.screenHeight = sanitizeOptionalInteger(meta.screenHeight, 240, 10000);
  if (meta.storageQuota !== undefined) next.storageQuota = sanitizeOptionalInteger(meta.storageQuota, 1, 1048576);
  if (meta.taskbarHeight !== undefined) next.taskbarHeight = sanitizeOptionalInteger(meta.taskbarHeight, 0, 500);
  if (meta.fontsDir !== undefined) next.fontsDir = sanitizeOptionalFontsDir(meta.fontsDir);
  if (meta.extensions !== undefined) next.extensions = normalizeExtensionMap(meta.extensions);

  cp[dirId] = next;
  cfg.cloakProfiles = cp;
  saveConfig(cfg);
}

export function removeProfileMeta(dirId: string): void {
  validateDirId(dirId);
  const cfg = getConfig();
  if (cfg.cloakProfiles && Object.hasOwn(cfg.cloakProfiles, dirId)) delete cfg.cloakProfiles[dirId];
  saveConfig(cfg);
}

// ── Sync ──

export function getSyncConfig() {
  return { ...getConfig().sync };
}

export function setSyncConfig(sync: Partial<import("../types.js").SyncConfig>): void {
  const cfg = getConfig();
  const allowed: Array<keyof import("../types.js").SyncConfig> = ["enabled", "endpoint", "bucket", "accessKey", "secretKey"];
  const next = { ...cfg.sync };
  for (const key of allowed) {
    const value = sync[key];
    if (value === undefined) continue;
    if ((key === "accessKey" || key === "secretKey") && value === "") continue;
    // Encrypt the secret key at rest.
    if (key === "secretKey" && typeof value === "string" && value && !isEncrypted(value)) {
      (next as any)[key] = encryptSecret(value);
    } else {
      (next as any)[key] = value;
    }
  }
  next.endpoint = normalizeSyncEndpoint(next.endpoint || "");
  next.bucket = normalizeSyncBucket(next.bucket || "");
  cfg.sync = next;
  saveConfig(cfg);
}

function normalizeSyncEndpoint(value: string): string {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  if (!endpoint) return "";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid sync endpoint: ${JSON.stringify(value)}`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("Sync endpoint must not include credentials or fragments");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("Sync endpoint must use https, except loopback http for local development");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeSyncBucket(value: string): string {
  const bucket = String(value || "").trim();
  if (!bucket) return "";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || bucket.includes(".-") || bucket.includes("-.")) {
    throw new Error(`Invalid sync bucket: ${JSON.stringify(value)}`);
  }
  return bucket;
}

export function reloadConfig(): void {
  config = loadConfig();
}

// ── Internal ──

function loadConfig(): MgmtConfig {
  ensureAppDir();
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    const initial = structuredClone(DefaultConfig);
    saveConfig(initial);
    return structuredClone(initial);
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MgmtConfig>;
    return mergeConfig(DefaultConfig, parsed, "load");
  } catch (e) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${configPath}.${timestamp}.bak`;
    console.error(`Failed to parse config.json, moved corrupt file to ${backupPath} and using defaults:`, e);
    try {
      fs.renameSync(configPath, backupPath);
    } catch (backupError) {
      console.error("Failed to back up corrupt config.json; leaving original file in place:", backupError);
    }
    return structuredClone(DefaultConfig);
  }
}

export function saveConfig(cfg: MgmtConfig): void {
  ensureAppDir();
  const configPath = getConfigPath();
  const normalized = mergeConfig(DefaultConfig, cfg, "save");
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch (e) { console.error("Failed to restrict config file permissions:", e); }
  config = normalized;
}

function ensureAppDir(): void {
  const appDataDir = getAppDataDir();
  if (!fs.existsSync(appDataDir)) {
    fs.mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(appDataDir, 0o700); } catch (e) { console.error("Failed to restrict app data directory permissions:", e); }
  }
}

function mergeConfig(defaults: MgmtConfig, parsed: Partial<MgmtConfig> | any, mode: "load" | "save"): MgmtConfig {
  const merged = structuredClone(defaults);
  if (parsed.version) merged.version = Math.max(3, parsed.version);
  if (parsed.cloakBin) merged.cloakBin = parsed.cloakBin;
  if (parsed.proxies) {
    const rawProxies = { ...defaults.proxies, ...parsed.proxies };
    merged.proxies = {};
    for (const [name, proxy] of Object.entries(rawProxies)) {
      validateProxyName(name);
      merged.proxies[name] = normalizeProxyConfig(proxy as ProxyConfig);
    }
    if (!merged.proxies["default"]) {
      merged.proxies["default"] = { ...DefaultProxy };
    }
  }
  if (parsed.defaultProxy && isValidProxyName(parsed.defaultProxy) && Object.hasOwn(merged.proxies, parsed.defaultProxy)) merged.defaultProxy = parsed.defaultProxy;
  if (parsed.proxyDetections) {
    merged.proxyDetections = normalizeProxyDetections(parsed.proxyDetections, merged.proxies);
  }
  if (parsed.sync) {
    merged.sync = { ...merged.sync, ...parsed.sync };
    try {
      merged.sync.endpoint = normalizeSyncEndpoint(merged.sync.endpoint || "");
      merged.sync.bucket = normalizeSyncBucket(merged.sync.bucket || "");
    } catch (e) {
      console.error("Invalid sync configuration ignored while loading config:", e);
      merged.sync = { ...defaults.sync };
    }
  }
  if (parsed.extensionRepository) {
    merged.extensionRepository = normalizeExtensionRepository(parsed.extensionRepository, {
      relocateStoredPaths: mode === "load",
      skipInvalidEntries: mode === "load",
    });
  }
  if (parsed.skillRepository) {
    merged.skillRepository = normalizeSkillRepository(parsed.skillRepository);
  }
  if (parsed.skillCatalogSources) {
    merged.skillCatalogSources = normalizeSkillCatalogSources(parsed.skillCatalogSources);
  }
  if (Array.isArray(parsed.automation)) {
    merged.automation = normalizeAutomationRules(parsed.automation);
  }
  if (Array.isArray(parsed.agentRuns)) {
    merged.agentRuns = normalizeAgentRuns(parsed.agentRuns);
  }
  if (parsed.agentFs && typeof parsed.agentFs === "object") {
    merged.agentFs = normalizeAgentFs(parsed.agentFs);
  }
  if (parsed.cloakProfiles) {
    merged.cloakProfiles = {};
    for (const [dirId, rawProfile] of Object.entries(parsed.cloakProfiles)) {
      validateDirId(dirId);
      const profile = { ...(rawProfile as CloakProfileMeta) };
      profile.proxyMode = normalizeProxyMode(profile.proxyMode, profile.proxyName || null, true);
      if (profile.proxyMode === "named") {
        if (!profile.proxyName || !isValidProxyName(profile.proxyName)) {
          profile.proxyMode = "none";
          profile.proxyName = null;
        }
      } else {
        profile.proxyName = null;
      }
      profile.platform = profile.platform === "macos" ? "macos" : "windows";
      profile.fingerprintSeed = sanitizeFingerprintSeed(profile.fingerprintSeed || 12345);
      profile.timezone = sanitizeOptionalTimezone(profile.timezone);
      profile.locale = sanitizeOptionalLocale(profile.locale);
      profile.webrtcIp = sanitizeOptionalIp(profile.webrtcIp);
      profile.gpuVendor = sanitizeOptionalText(profile.gpuVendor, 80);
      profile.gpuRenderer = sanitizeOptionalText(profile.gpuRenderer, 160);
      profile.hardwareConcurrency = sanitizeOptionalInteger(profile.hardwareConcurrency, 1, 64);
      profile.deviceMemory = sanitizeOptionalInteger(profile.deviceMemory, 1, 128);
      profile.screenWidth = sanitizeOptionalInteger(profile.screenWidth, 320, 10000);
      profile.screenHeight = sanitizeOptionalInteger(profile.screenHeight, 240, 10000);
      profile.storageQuota = sanitizeOptionalInteger(profile.storageQuota, 1, 1048576);
      profile.taskbarHeight = sanitizeOptionalInteger(profile.taskbarHeight, 0, 500);
      profile.fontsDir = sanitizeOptionalFontsDir(profile.fontsDir);
      profile.tags = normalizeProfileTags(profile.tags);
      profile.extensions = normalizeExtensionMap(profile.extensions);
      merged.cloakProfiles[dirId] = profile;
    }
  }
  if (parsed.llm) merged.llm = normalizeLlmConfig(parsed.llm);
  if (parsed.accounts) merged.accounts = normalizeAccounts(parsed.accounts);
  for (const [key, value] of Object.entries(parsed)) {
    if (key in merged || key === "profiles" || key === "firefoxProfiles" || key === "chromeProfiles" || key === "chromeBin") continue;
    (merged as any)[key] = value;
  }
  return merged;
}

function normalizeLlmConfig(raw: any): LlmConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const provider = raw.provider === "openai" || raw.provider === "claude" || raw.provider === "custom" ? raw.provider : "openai";
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (!apiKey) return undefined;
  if (apiKey.length > 4096) throw new Error("LLM API key exceeds maximum length");
  const apiUrl = sanitizeOptionalText(raw.apiUrl, 1000) || undefined;
  const model = sanitizeOptionalText(raw.model, 200) || undefined;
  return { provider, apiKey, apiUrl, model };
}

function normalizeAccounts(raw: any): PlatformAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 1000).map((item: any) => {
    if (!item || typeof item !== "object") return null;
    const platformUrl = sanitizeOptionalText(item.platformUrl, 1000);
    const platformUserName = sanitizeOptionalText(item.platformUserName, 200);
    if (!platformUrl || !platformUserName) return null;
    const rawPassword = typeof item.platformPassword === "string" ? item.platformPassword : "";
    // Encrypt at rest (passthrough when safeStorage unavailable).
    const platformPassword = rawPassword && !isEncrypted(rawPassword) ? encryptSecret(rawPassword) : rawPassword;
    const profileIds = Array.isArray(item.profileIds)
      ? item.profileIds.filter((p: any) => typeof p === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(p)).slice(0, 200)
      : undefined;
    const tags = Array.isArray(item.tags)
      ? item.tags.map((t: any) => sanitizeOptionalText(t, 40)).filter((t: string | null): t is string => Boolean(t)).slice(0, 20)
      : undefined;
    return {
      platformUrl,
      platformUserName,
      platformPassword,
      profileIds,
      tags,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : undefined,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : undefined,
    } as PlatformAccount;
  }).filter((a: PlatformAccount | null): a is PlatformAccount => Boolean(a));
}

const AUTOMATION_TRIGGER_TYPES = new Set(["cron", "once", "event"]);
const AUTOMATION_ACTION_TYPES = new Set(["launch-profile", "stop-profile", "agent-task", "sync-push", "sync-pull", "custom-js", "run-workflow"]);
const AUTOMATION_EVENTS = new Set(["profile:launched", "profile:exited"]);

function normalizeAutomationRules(raw: any): AutomationRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).map((item: any): AutomationRule | null => {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    if (!/^rule_[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
    const name = sanitizeOptionalText(item.name, 120) || id;
    const t = item.trigger || {};
    const triggerType = AUTOMATION_TRIGGER_TYPES.has(t.type) ? t.type : null;
    if (!triggerType) return null;
    const a = item.action || {};
    const actionType = AUTOMATION_ACTION_TYPES.has(a.type) ? a.type : null;
    if (!actionType) return null;
    const trigger: AutomationTrigger = { type: triggerType as AutomationTriggerType };
    if (triggerType === "cron" && typeof t.cron === "string") {
      trigger.cron = t.cron.slice(0, 100);
    }
    if (triggerType === "once" && typeof t.at === "number") {
      trigger.at = t.at;
    }
    if (triggerType === "event" && AUTOMATION_EVENTS.has(t.event)) {
      trigger.event = t.event as AutomationTrigger["event"];
      if (t.profileFilter) trigger.profileFilter = String(t.profileFilter).slice(0, 100);
    }
    const action: AutomationAction = { type: actionType as AutomationActionType };
    if (a.profileDirId && typeof a.profileDirId === "string") action.profileDirId = String(a.profileDirId).slice(0, 100);
    if (typeof a.templateId === "string") action.templateId = sanitizeOptionalText(a.templateId, 80) || undefined;
    if (typeof a.agentPrompt === "string") action.agentPrompt = a.agentPrompt.slice(0, 8000);
    if (typeof a.jsCode === "string") action.jsCode = a.jsCode.slice(0, 50000);
    // Execution-hardening fields (optional; preserved across save).
    const runTimeoutMs = typeof item.runTimeoutMs === "number" && Number.isFinite(item.runTimeoutMs)
      ? Math.min(Math.max(Math.round(item.runTimeoutMs), 1000), 24 * 3600 * 1000) : undefined;
    const maxRetries = Number.isInteger(item.maxRetries) ? Math.min(Math.max(item.maxRetries, 0), 10) : undefined;
    // Runtime state (maintained by JobGuard).
    const failureCount = Number.isInteger(item.failureCount) && item.failureCount >= 0 ? item.failureCount : undefined;
    const lastError = typeof item.lastError === "string" ? item.lastError.slice(0, 1000) : undefined;
    const cooldownUntil = typeof item.cooldownUntil === "number" && item.cooldownUntil > 0 ? item.cooldownUntil : undefined;
    return {
      id,
      name,
      enabled: Boolean(item.enabled),
      trigger,
      action,
      lastRunAt: typeof item.lastRunAt === "number" ? item.lastRunAt : undefined,
      lastResult: typeof item.lastResult === "string" ? item.lastResult.slice(0, 500) : undefined,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(failureCount !== undefined ? { failureCount } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
    };
  }).filter((r: AutomationRule | null): r is AutomationRule => Boolean(r));
}

// ── Agent Run trace normalization ──
const AGENT_RUN_STATUSES = new Set<AgentRunStatus>(["running", "done", "error"]);
const RUN_ID_RE = /^run_[a-zA-Z0-9_-]{1,80}$/;
const STEP_ID_RE = /^step_[a-zA-Z0-9_-]{1,80}$/;
const SECRET_KEY_RE = /authorization|cookie|password|secret|token|api[-_]?key|credentials?/i;

/** Recursively sanitize a trace payload: slice strings, cap arrays/keys, redact secret keys. */
export function sanitizeTracePayload(value: unknown, maxStringLength: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > maxStringLength ? value.slice(0, maxStringLength) : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => sanitizeTracePayload(v, maxStringLength));
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 100) break;
    // Redact secret-like keys entirely
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeTracePayload(v, maxStringLength);
    }
    count++;
  }
  return out;
}

function normalizeAgentRunSource(raw: any): AgentRunSource {
  const type = raw?.type === "automation" ? "automation" : "chat";
  const src: AgentRunSource = { type };
  if (typeof raw?.conversationId === "string") src.conversationId = raw.conversationId.slice(0, 100);
  if (typeof raw?.ruleId === "string") src.ruleId = raw.ruleId.slice(0, 100);
  if (typeof raw?.ruleName === "string") src.ruleName = raw.ruleName.slice(0, 120);
  if (typeof raw?.jobId === "string") src.jobId = raw.jobId.slice(0, 120);
  return src;
}

function normalizeAgentRunStep(raw: any, index: number): AgentRunStep | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && STEP_ID_RE.test(raw.id) ? raw.id : "step_" + index;
  const tool = String(raw.tool || "").slice(0, 80);
  if (!tool) return null;
  return {
    id,
    tool,
    args: sanitizeTracePayload(raw.args, 8 * 1024),
    result: raw.result === undefined ? undefined : sanitizeTracePayload(raw.result, 16 * 1024),
    ok: raw.ok === true,
    error: typeof raw.error === "string" ? raw.error.slice(0, 1000) : undefined,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
  };
}

function normalizeAgentRuns(raw: any): AgentRun[] {
  if (!Array.isArray(raw)) return [];
  // Keep the NEWEST 200 runs (drop oldest).
  const recent = raw.length > 200 ? raw.slice(raw.length - 200) : raw;
  return recent.map((r: any): AgentRun | null => {
    if (!r || typeof r !== "object") return null;
    const id = String(r.id || "").trim();
    if (!RUN_ID_RE.test(id)) return null;
    const name = (typeof r.name === "string" ? r.name.slice(0, 160) : id) || id;
    const startedAt = typeof r.startedAt === "number" ? r.startedAt : 0;
    // Stale "running" runs (loaded from disk after a crash) → mark error so they don't dangle.
    const rawStatus = String(r.status) as string;
    const isKnown = rawStatus === "running" || rawStatus === "done" || rawStatus === "error";
    const status: AgentRunStatus = (!isKnown || rawStatus === "running") ? "error" : (rawStatus as AgentRunStatus);
    const steps = Array.isArray(r.steps)
      ? r.steps.slice(0, 500).map((s: any, i: number) => normalizeAgentRunStep(s, i)).filter((s: AgentRunStep | null): s is AgentRunStep => Boolean(s))
      : [];
    const variables: Record<string, string> = {};
    if (r.variables && typeof r.variables === "object") {
      let vc = 0;
      for (const [k, v] of Object.entries(r.variables as Record<string, unknown>)) {
        if (vc >= 100) break;
        if (typeof v === "string") variables[String(k).slice(0, 64)] = v.slice(0, 16 * 1024);
        vc++;
      }
    }
    return {
      id,
      name,
      summary: typeof r.summary === "string" ? r.summary.slice(0, 500) : undefined,
      source: normalizeAgentRunSource(r.source),
      status,
      startedAt,
      finishedAt: typeof r.finishedAt === "number" ? r.finishedAt : (status !== "running" ? Date.now() : undefined),
      steps,
      variables,
      error: status === "error" && typeof r.error === "string" ? r.error.slice(0, 1000) : undefined,
    };
  }).filter((r: AgentRun | null): r is AgentRun => Boolean(r));
}

function normalizeAgentFs(raw: any): AgentFsConfig {
  const mode: AgentFsMode = raw?.mode === "allowlist" || raw?.mode === "open" ? raw.mode : "sandbox";
  const allowlist: string[] = [];
  if (Array.isArray(raw?.allowlist)) {
    const seen = new Set<string>();
    for (const d of raw.allowlist) {
      if (typeof d !== "string") continue;
      const trimmed = d.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      allowlist.push(trimmed.slice(0, 500));
      if (allowlist.length >= 50) break;
    }
  }
  return { mode, allowlist };
}
