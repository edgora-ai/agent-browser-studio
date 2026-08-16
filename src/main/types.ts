// ── Shared types for Agent Browser Studio ──

export interface ProxyConfig {
  type: "http" | "socks5" | "socks5h";
  host: string;
  port: number;
  username?: string;
  password?: string;
  bypassList?: string[];
  /** Backup proxy names tried (in order) when this proxy is unhealthy. */
  fallbacks?: string[];
  /** Last edit time (carried through sync for newest-merge). */
  updatedAt?: number;
}

export interface ProxyDetectionCacheEntry {
  detectedAt: number;
  success: boolean;
  exitIp: string | null;
  country: string | null;
  countryCode: string | null;
  timezone: string | null;
  provider: string | null;
  latencyMs: number | null;
  org?: string | null;
  as?: string | null;
  hosting?: boolean | null;
  isProxy?: boolean | null;
  error: string | null;
}

export interface ProxyHealthHistoryPoint {
  at: number;
  success: boolean;
  exitIp: string | null;
  countryCode: string | null;
  timezone: string | null;
  provider: string | null;
  latencyMs: number | null;
  isp: string | null;
  org: string | null;
  as: string | null;
  hosting?: boolean | null;
  isProxy?: boolean | null;
  error: string | null;
}

export type ProxyRiskLevel = "good" | "watch" | "poor";

export interface ProxyHealthEntry {
  proxyName: string;
  firstSeenAt: number;
  lastCheckedAt: number;
  lastSuccessAt: number | null;
  checks: number;
  successes: number;
  consecutiveFailures: number;
  distinctExitIps: string[];
  ipDriftCount: number;
  geoDriftCount: number;
  avgLatencyMs: number | null;
  score: number;
  risk: ProxyRiskLevel;
  history: ProxyHealthHistoryPoint[];
  bindings: string[];
  cooldownUntil: number | null;
  suggestion: string | null;
  rotations: number;
  lastRotatedAt: number | null;
  lastRotatedTo: string | null;
}

export type ProxyMode = "none" | "default" | "named";

/** One persisted in-browser WebRTC diagnostics run for a profile. */
export interface WebRtcDiagnosticsEntry {
  at: number;
  success: boolean;
  rtcAvailable: boolean;
  candidates: string[];
  mdnsHosts: string[];
  hostIps: string[];
  srflxIps: string[];
  connectionState: string;
  rttMs: number | null;
  error: string | null;
  summary: string;
}

export interface ResolvedProfileProxy {
  mode: ProxyMode;
  name: string | null;
  config: ProxyConfig | null;
  /** Set when the configured proxy was unhealthy and a fallback was selected. */
  rotatedFrom?: string | null;
  rotationReason?: string | null;
}

export type BrowserPlatform = "windows" | "macos";
export type GeolocationMode = "real" | "disable" | "custom";
export type WebRtcMode = "auto" | "real" | "altered" | "disable";
export type FingerprintMode = "managed" | "off";

export interface BrowserFingerprintMeta {
  /** `off` launches the selected build with all managed identity consumers disabled. */
  fingerprintMode?: FingerprintMode;
  /** Exact installed independent Chromium build, or null for newest installed. */
  browserVersion?: string | null;
  /** Opt-in stock preference mode for embedded auth/payment/challenge flows. */
  allowThirdPartyCookies?: boolean;
  fingerprintSeed?: number;
  platform?: BrowserPlatform;
  timezone?: string | null;
  locale?: string | null;
  webrtcMode?: WebRtcMode;
  webrtcIp?: string | null;
  geolocationMode?: GeolocationMode;
  geolocationLatitude?: number | null;
  geolocationLongitude?: number | null;
  geolocationAccuracy?: number | null;
  gpuVendor?: string | null;
  gpuRenderer?: string | null;
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  storageQuota?: number | null;
  taskbarHeight?: number | null;
  fontsDir?: string | null;
  /** Captured live-fingerprint baseline for drift detection. */
  fingerprintBaseline?: Record<string, unknown>;
}

export interface ProfileLock {
  /** deviceId of the device that checked this profile out. */
  owner: string;
  /** hostname of the owning device (human-readable). */
  ownerName: string;
  /** epoch ms when the lock was taken. */
  at: number;
}

export interface BrowserProfileMeta extends BrowserFingerprintMeta {
  name: string;
  windowTitlePrefix?: string | null;
  /** Web App (PWA) mode: when set, the profile launches as a standalone app window at this URL (RoxyBrowser 3.9.2 "PWA / Sub apps" parity). */
  appUrl?: string | null;
  proxyMode?: ProxyMode;
  proxyName?: string | null;
  /** When true, the profile launches with Widevine/DRM enabled when a CDM is available. */
  drm?: boolean;
  syncedAt?: number;
  syncedHash?: string;
  note?: string | null;
  tags?: string[];
  /** Business preset id used at creation (Slice 75). */
  preset?: string | null;
  extensions?: Record<string, boolean>;
  /** Last user edit time (carried through sync for newest-merge). */
  updatedAt?: number;
  /** Team checkout lock: another device holds this profile (push protection). */
  lock?: ProfileLock;
}

export interface ExtensionRepositoryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "chrome-web-store" | "local";
  chromeStoreUrl?: string;
  updateUrl?: string;
  unpackedPath: string;
  packageHash: string;
  manifestHash: string;
  shared: boolean;
  tags: string[];
  addedAt: number;
  updatedAt: number;
}

export type SkillSource = "built-in" | "local" | "shared-catalog";

export interface SkillRepositoryEntry {
  id: string;
  name: string;
  title: string;
  version: string;
  description: string;
  source: SkillSource;
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

export interface SkillCatalogSource {
  id: string;
  name: string;
  url?: string;
  enabled: boolean;
  addedAt: number;
}

export interface ProfileInfo {
  dirId: string;
  name: string;
  path: string;
  sizeBytes: number;
  lastModified: number;
  running: boolean;
  pid: number | null;
  proxy: ProxyConfig | null;
  proxyName: string | null;
  proxyMode: ProxyMode;
  syncedAt: number | null;
  syncStatus: "synced" | "dirty" | "never";
  tags: string[];
  fingerprint: BrowserFingerprintMeta;
}

export interface CookieInfo {
  domain: string;
  name: string;
  value: string;
  path: string;
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: number;
}

export interface SyncConfig {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export interface TeamMember {
  /** deviceId of the member device. */
  deviceId: string;
  /** Human-readable device name (deviceName). */
  name: string;
  role: TeamRole;
  addedAt: number;
}

export interface TeamConfig {
  /** Workspace display name. */
  name: string;
  /** deviceId of the workspace owner. */
  ownerDeviceId: string;
  /** Member roster (the owner is always the first entry). */
  members: TeamMember[];
  /** When false, team enforcement is dormant. Default true once initialized. */
  enabled?: boolean;
  updatedAt: number;
}

export interface LlmConfig {
  provider: "openai" | "claude" | "custom";
  apiKey: string;
  apiUrl?: string;
  model?: string;
}

export interface PlatformAccount {
  platformUrl: string;
  platformUserName: string;
  platformPassword: string;
  profileIds?: string[];
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface MgmtConfig {
  version: number;
  /** Stable per-install device identity used for team profile locks. */
  deviceId?: string;
  deviceName?: string;
  chromiumBin?: string;
  defaultProxy: string;
  proxies: Record<string, ProxyConfig>;
  proxyDetections?: Record<string, ProxyDetectionCacheEntry>;
  proxyHealth?: Record<string, ProxyHealthEntry>;
  webrtcDiagnostics?: Record<string, WebRtcDiagnosticsEntry[]>;
  sync: SyncConfig;
  browserProfiles: Record<string, BrowserProfileMeta>;
  extensionRepository?: Record<string, ExtensionRepositoryEntry>;
  skillRepository?: Record<string, SkillRepositoryEntry>;
  skillCatalogSources?: SkillCatalogSource[];
  llm?: LlmConfig;
  accounts?: PlatformAccount[];
  automation?: AutomationRule[];
  agentRuns?: AgentRun[];
  agentFs?: AgentFsConfig;
  /** When true, pre-launch consistency blockers refuse the launch. Default false (warn only). */
  blockOnConsistencyConflict?: boolean;
  /** When true, pre-launch proxy-risk findings (IDC/hosting or public-proxy exit) become blockers. Default false (warn only). */
  blockOnProxyRisk?: boolean;
  /** When true (default), a post-launch fingerprint drift on high-risk fields stops the browser. */
  blockOnFingerprintDrift?: boolean;
  /** When true, launch is refused when the host environment check finds high-risk findings (DNS leak / CN fonts / SOCKS5 DNS). Default false (warn only). */
  blockOnEnvironmentRisk?: boolean;
  /** Widevine/DRM discovery settings (managed CDM path override). */
  drm?: DrmConfig;
  /** Team workspace RBAC (members, roles, enforcement). */
  team?: TeamConfig;
  /** Max automation jobs running concurrently. Default 3. */
  maxConcurrentJobs?: number;
}

export interface DrmConfig {
  /** Explicit Widevine CDM directory override (auto-detected when unset). */
  cdmPath?: string | null;
  /** Epoch ms of the last successful CDM detection. */
  detectedAt?: number;
  /** Version string of the last detected CDM. */
  detectedVersion?: string;
}

// ── Agent Runs (inspectable trace of each agent task execution) ──
export type AgentRunStatus = "running" | "done" | "error";

export interface AgentRunSource {
  type: "chat" | "automation";
  conversationId?: string;
  ruleId?: string;
  ruleName?: string;
  jobId?: string;
  /** When set, this run is a manual retry of the referenced run (same profile). */
  retryOf?: string;
}

export interface AgentRunStep {
  id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
}

export interface AgentRun {
  id: string;                 // run_<random>
  dirId?: string;             // profile this run was scoped to (batch/automation)
  name: string;
  summary?: string;
  source: AgentRunSource;
  status: AgentRunStatus;
  startedAt: number;
  finishedAt?: number;
  steps: AgentRunStep[];
  variables: Record<string, string>;
  error?: string;
}

// ── Agent filesystem access config ──
export type AgentFsMode = "sandbox" | "allowlist" | "open";

export interface AgentFsConfig {
  mode: AgentFsMode;
  allowlist: string[];        // trusted absolute dirs (used in allowlist mode)
}

// ── Automation (scheduled tasks + event triggers) ──
export type AutomationTriggerType = "cron" | "once" | "event";
export type AutomationActionType =
  | "launch-profile"
  | "stop-profile"
  | "agent-task"
  | "sync-push"
  | "sync-pull"
  | "custom-js";

export interface AutomationTrigger {
  type: AutomationTriggerType;
  cron?: string;            // cron: "0 9 * * *" (min hour dom mon dow)
  at?: number;              // once: epoch ms
  event?: "profile:launched" | "profile:exited";
  profileFilter?: string;   // event: only match this profile dirId
}

export interface AutomationAction {
  type: AutomationActionType;
  profileDirId?: string;    // launch/stop/agent (single)
  profileDirIds?: string[]; // batch agent-task: run the same prompt across these profiles
  concurrency?: number;    // batch agent-task: profiles launched in parallel (default 1 = sequential)
  templateId?: string;      // agent-task built-in template id
  agentPrompt?: string;     // agent-task preset prompt
  jsCode?: string;          // custom-js
}

export interface AutomationRule {
  id: string;               // rule_<random>
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  lastRunAt?: number;
  lastResult?: string;
  createdAt: number;
  // ── Execution hardening (optional; defaults applied by JobGuard) ──
  /** Per-run wall-clock timeout in ms. Default 300000 (5 min). */
  runTimeoutMs?: number;
  /** Max automatic retries on failure (exponential backoff). Default 0. */
  maxRetries?: number;
  // ── Runtime state (maintained by JobGuard, persisted for observability) ──
  failureCount?: number;
  lastError?: string;
  cooldownUntil?: number;
}

export interface StorageInfo {
  profiles: Array<{
    dirId: string;
    name: string;
    browser: "chromium";
    sizeBytes: number;
    lastModified: number;
  }>;
  totalProfileBytes: number;
  availableDiskBytes: number;
  diskUsagePercent: number;
}

export interface LaunchResult {
  pid: number;
  cdpPort: number;
}

export interface StatusResult {
  running: boolean;
  pid: number | null;
  cdpPort: number | null;
}

export interface SyncResult {
  success: boolean;
  message: string;
  transferredBytes?: number;
}

// ── Updates (version-aware release store with pin + rollback) ──
export interface UpdateRelease {
  version: string;          // dot-separated numeric, e.g. 1.1.0
  url: string;              // http(s):// or file:// archive (.zip), or local dir path
  sha256?: string;          // hex digest of the archive bytes (dir payloads skip this)
  notes?: string;           // human changelog for the UI
  publishedAt?: string;     // ISO timestamp
  minSupported?: string;    // minimum current app version allowed to install this
}

export interface UpdateManifest {
  product: string;          // must equal "agent-browser-studio"
  channel?: string;         // e.g. stable / beta
  releases: UpdateRelease[];
}

export type InstalledUpdateStatus = "staged" | "active" | "retired";

export interface InstalledUpdate {
  version: string;
  status: InstalledUpdateStatus;
  installedAt: number;
  sha256?: string | null;
  url?: string | null;
}

export interface UpdateHistoryEntry {
  at: number;
  action: "check" | "install" | "activate" | "rollback" | "auto-rollback";
  version: string | null;
  from: string | null;
  detail: string | null;
}

export interface UpdateState {
  activeVersion: string;
  previousVersion: string | null;
  channel: string;
  manifestUrl: string | null;
  lastCheckedAt: number | null;
  lastCheckError: string | null;
  crashCount: number;
  lastCrashAt: number | null;
  lastAutoRollbackAt: number | null;
  installed: InstalledUpdate[];
  history: UpdateHistoryEntry[];
}

export interface UpdateCheckResult {
  currentVersion: string;
  available: UpdateRelease[];
  checkedAt: number;
  error: string | null;
}
