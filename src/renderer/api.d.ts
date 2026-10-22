import type { SyncConfig, SyncResult, SyncComparisonToken, ProfileHealthKind, ProfileHealthOutcome, ProfileHealthEntry, WebRtcDiagnosticsEntry, ProxyDetectionCacheEntry, ProxyObservationMetadata } from "../main/types.js";
import type { FingerprintComparisonReport } from "../main/services/fingerprint-drift-reports.js";
export type { FingerprintComparisonReport } from "../main/services/fingerprint-drift-reports.js";
import type { ProxyDetectionResult } from "../main/services/proxy-detector.js";
export type { ProxyDetectionCacheEntry, ProxyObservationMetadata, ProxyDetectionResult };
export type { ProfileHealthKind, ProfileHealthOutcome, ProfileHealthEntry, WebRtcDiagnosticsEntry } from "../main/types.js";
import type { ProfileNetworkPage, ProfileNetworkPagesResult, ProfileNetworkObservationResult, ProfileNetworkArmedEvent } from "../main/types.js";
export type { ProfileNetworkPage, ProfileNetworkPagesResult, ProfileNetworkObservationResult, ProfileNetworkArmedEvent,
  NetworkCounts, NetworkCoverage, NetworkObservationSummary, NetworkObservationPayload, ObservedNetworkHop, NetworkHttpStatusEvidence } from "../main/types.js";
import type { SyncDiffResult } from "../main/services/sync-service.js";
import type { ActiveSyncOperation } from "../main/services/sync/operation-state.js";

export type ProxyMode = "none" | "default" | "named";

export interface ProxyConfig {
  type: "http" | "socks5" | "socks5h";
  host: string;
  port: number;
  username?: string;
  password?: string;
  bypassList?: string[];
  fallbacks?: string[];
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

export interface AccountReference {
  index: number;
  revision: string;
}

export interface RedactedPlatformAccount {
  ref: AccountReference;
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
  rotatedFrom?: string | null;
  rotationReason?: string | null;
}

export type ProxyRiskLevel = "good" | "watch" | "poor";

export interface ProxyHealthHistoryPoint {
  at: number | null;
  source?: ProxyObservationMetadata["source"];
  observationId?: string | null;
  hosting?: boolean | null;
  isProxy?: boolean | null;
  success: boolean;
  exitIp: string | null;
  countryCode: string | null;
  timezone: string | null;
  provider: string | null;
  latencyMs: number | null;
  isp: string | null;
  org: string | null;
  as: string | null;
  error: string | null;
}

export interface ProxyHealthEntry {
  proxyName: string;
  firstSeenAt: number | null;
  lastCheckedAt: number | null;
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
  freshness?: "fresh" | "stale" | "unknown";
  observationAgeMs?: number | null;
  history: ProxyHealthHistoryPoint[];
  bindings: string[];
  cooldownUntil: number | null;
  suggestion: string | null;
  rotations: number;
  lastRotatedAt: number | null;
  lastRotatedTo: string | null;
}

export interface ProxyHealthSummary {
  total: number;
  good: number;
  watch: number;
  poor: number;
  inCooldown: number;
  stale: number;
  unknown: number;
  lastCheckedAt: number | null;
}

export interface HealthResponse<T> {
  /** Transport/probe success is separate from the business conclusion. */
  ok: boolean;
  outcome: ProfileHealthOutcome;
  requestId?: string;
  result?: T;
  code?: string;
  error?: string;
}

export interface EnvRiskResult {
  at?: number;
  ok: boolean;
  summary?: string;
  hostPlatform: string;
  hostLocale: string | null;
  findings: Array<{ severity: string; code: string; message: string; fix: string }>;
  resolvers: Array<{ address: string; isCn?: boolean }>;
  cnFonts: string[];
  proxy?: { mode: string; type?: string; dnsLeakRisk?: string };
  raf?: { samples: number; medianMs: number; refreshHz: number; standard: boolean };
}

export interface BaselineCaptureResult extends Omit<HealthResponse<never>, "result"> {
  fields?: number;
  risky?: boolean;
  partial?: boolean;
  review?: boolean;
  report?: FingerprintComparisonReport;
  currentConfigMatches?: boolean;
  canUpdateBaseline?: boolean;
  drift?: Array<{ field: string; baseline: unknown; current: unknown }>;
  baseline?: Record<string, unknown>;
  /** Opaque, single-use review bound to baseline/config/runtime/live snapshot. */
  confirmationToken?: string;
  baselineCommitted?: boolean;
  warning?: string;
}

export interface LaunchDriftCheck {
  checked: boolean;
  risky?: boolean;
  drift?: Array<{ field: string; baseline: unknown; current: unknown }>;
  observedAt?: number;
  partial?: boolean;
  review?: boolean;
  blockingUnavailable?: boolean;
  report?: FingerprintComparisonReport;
  error?: string;
}

export interface FingerprintDriftCheckResult extends Omit<HealthResponse<never>, "result"> {
  hasBaseline?: boolean;
  checked?: boolean;
  risky?: boolean;
  partial?: boolean;
  review?: boolean;
  blockingUnavailable?: boolean;
  observedAt?: number;
  fields?: number;
  report?: FingerprintComparisonReport;
  currentConfigMatches?: boolean;
  canUpdateBaseline?: boolean;
  historySaved?: boolean;
  warning?: string;
  drift?: Array<{ field: string; baseline: unknown; current: unknown }>;
  /** Historical audit evidence only; not a live check or current configuration verdict. */
  lastBlocked?: { at: number; fields: string[] };
}

export interface BaselineResetResult {
  ok: boolean;
  code?: string;
  outcome?: ProfileHealthOutcome;
  /** Server-issued review token; send only after explicit human confirmation. */
  confirmationToken?: string;
  baselineReset?: boolean;
  error?: string;
  warning?: string;
}

export interface EnvRiskDiagnosticsEntry {
  outcome?: ProfileHealthOutcome;
  requestId?: string;
  source?: ProfileHealthEntry["source"];
  at: number;
  ok: boolean;
  high: number;
  medium: number;
  summary: string;
  findings: Array<{ severity: string; code: string; message: string; fix: string }>;
  resolvers: string[];
  cnFonts: string[];
}

export interface BrowserProfileInfo {
  /** Runtime discovery is independent of metadata; null means not yet known. */
  installed?: boolean | null;
  runtimePending?: boolean;
  dirId: string;
  name: string;
  version: string;
  engine: "chromium" | "firefox";
  browserVersion: string | null;
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
  /** Raster scale strategy at launch; `native` renders at the host scale (sharp), `strict` forces the spoofed DPR. */
  renderScaleMode: "native" | "strict";
  proxyMode: ProxyMode;
  proxyName: string | null;
  note: string | null;
  tags: string[];
  syncedAt: number | null;
  /** Content proof covers portable profile metadata and Preferences, not all browser data. */
  syncStatus: "synced" | "dirty" | "never" | "unknown";
  syncScope: "portable-profile+preferences";
  syncReason: "baseline-match" | "content-changed" | "no-baseline" | "legacy-marker" |
    "invalid-baseline" | "target-mismatch" | "target-unavailable" |
    "preferences-unavailable" | "content-unavailable";
  lastModified: number;
  running: boolean;
  unknown?: boolean;
  stopping?: boolean;
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

export interface FirefoxStatus {
  engine: "firefox";
  installed: boolean;
  path: string | null;
  version: string | null;
  fingerprintParity: false;
  hint: string;
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

export type AgentEndReason =
  | "completed"
  | "user_cancelled"
  | "timeout"
  | "round_limit"
  | "interrupted"
  | "execution_error";

/** M2 verification: a discriminated union. "unverified" is the honest default
 *  for anything not graded by a template verifier. */
export type AgentVerificationStatus = "unverified" | "passed" | "partial" | "failed" | "manual_review";

export interface AgentVerificationCounts {
  expected: number;
  observed: number;
  inspected: number;
  accepted: number;
  rejected: number;
  missing: number;
  extra: number;
}

export interface AgentVerificationIssue {
  code: string;
  item?: string;
  field?: string;
  detail?: string;
}

export type AgentVerification =
  | { status: "unverified" }
  | {
      status: "passed" | "partial" | "failed";
      verifierId: string;
      verifierVersion: number;
      checkedAt: number;
      counts: AgentVerificationCounts;
      issues: AgentVerificationIssue[];
      issuesTruncated: boolean;
    }
  | {
      status: "manual_review";
      checkedAt: number;
      reasonCode: string;
      verifierId?: string;
      verifierVersion?: number;
      issues?: AgentVerificationIssue[];
      issuesTruncated?: boolean;
    };

export interface AgentRunArtifactRef {
  id: string;
  kind: "dataset" | "file";
  name: string;
  mediaType: string;
  createdAt: number;
  bytes: number;
  sha256: string;
  completeness: "complete" | "partial";
  truncated: boolean;
  truncationReason?: string;
  rowCount?: number;
  sourceRowCount?: number;
  rejectedRowCount?: number;
  columns?: string[];
  redactedColumns?: string[];
  exportPolicy: "csv" | "original" | "none";
}

export type AgentRunExportKind = "summary-json" | "dataset-csv" | "file";

export interface AgentRunExportPlan {
  kind: AgentRunExportKind;
  format: "json" | "csv" | "original";
  suggestedName: string;
  extension: string;
  mediaType: string;
  columns?: string[];
  rowCount?: number;
  sourceRowCount?: number;
  rejectedRowCount?: number;
  warnings: string[];
  sha256?: string;
  bytes?: number;
  verification?: AgentVerification;
  truncated?: boolean;
}

export interface AgentRunResultsPreview {
  columns: string[];
  /** Row-major: each row aligns with `columns`. */
  rows: string[][];
  total: number;
  truncated: boolean;
  sourceRowCount: number;
  rejectedRowCount: number;
}

export interface AgentRunStep {
  id: string;
  tool: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
}

export interface AgentConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: Array<{ name: string; redacted: true }>;
  runId?: string;
  requestId?: string;
  endReason?: AgentEndReason;
  verification?: AgentVerification;
}

export interface AgentConversation {
  id: string;
  title: string;
  titleKind?: "default" | "literal" | null;
  createdAt: number;
  updatedAt: number;
  messages: AgentConversationMessage[];
}

export type AgentConversationSummary = Pick<AgentConversation, "id" | "title" | "titleKind" | "createdAt" | "updatedAt"> & {
  messageCount: number;
};

export interface AgentRun {
  id: string;
  dirId?: string;
  name: string;
  summary?: string;
  source: {
    type: "chat" | "automation";
    conversationId?: string;
    ruleId?: string;
    ruleName?: string;
    jobId?: string;
    retryOf?: string;
    templateId?: string;
    templateVersion?: number;
  };
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  endReason?: AgentEndReason;
  verification?: AgentVerification;
  artifacts?: AgentRunArtifactRef[];
  error?: string;
  steps: AgentRunStep[];
  variables: Record<string, string>;
  stepCount?: number;
}

export interface AgentActiveRunSnapshot {
  conversationId: string;
  streamId: string;
  runId?: string;
  profileDirId?: string;
  profileName?: string;
  state: "preparing" | "running" | "cancelling";
  startedAt: number;
  reply: string;
  toolCalls: Array<{ name: string; redacted: true }>;
  steps: AgentRunStep[];
  currentTool?: string;
}

export interface AgentStreamTerminal {
  conversationId: string;
  streamId: string;
  runId?: string;
  reply: string;
  toolCalls: Array<{ name: string; redacted: true }>;
  status: "done" | "error";
  endReason: AgentEndReason;
  verification: AgentVerification;
  persisted: boolean;
  error?: string;
  code?: string;
}

export interface AgentCancelResult {
  accepted: boolean;
  state: "cancelling" | "finished" | "not_found";
  runId?: string;
  streamId?: string;
  endReason?: AgentEndReason;
  error?: string;
}

/** M3: the scheduler's own account of what a rule will do next. */
export type SchedulePhase =
  | "event-driven" | "running" | "retry-waiting" | "queued" | "cooldown"
  | "scheduled-once" | "missed-once" | "scheduled-cron" | "invalid-cron"
  | "disabled-after-success" | "user-disabled";

export interface RuleScheduleState {
  ruleId: string;
  phase: SchedulePhase;
  nextRunAt: number | null;
  /** "armed-timer" is an observation; "computed" is derived for a far-future cron. */
  nextRunSource: "armed-timer" | "computed" | null;
  timezone: string;
  timezoneOffsetMinutes: number;
  onceAt: number | null;
  missedAt: number | null;
  cooldownUntil: number | null;
  lastOutcome: { status: string; at: number; attempt: number; error: string | null } | null;
  activeJob: { id: string; status: string; attempt: number; startedAt: number | null; retryAt: number | null } | null;
  lastAttempt: { attempt: number; error: string | null; at: number } | null;
  /** No planId, or no job carries it — the card must not borrow an older row. */
  degraded: boolean;
}

export interface StoredNotification {
  dedupKey: string;
  jobId: string | null;
  ruleId: string;
  planId: string | null;
  kind: "done" | "failed" | "cancelled" | "missed";
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
}

export interface ReconcileReport {
  success: boolean;
  reason?: string;
  /** Future timers rearmed by a live refresh, never a replayed execution. */
  rearmed?: boolean;
  timersRefreshed?: number;
  workStarted?: false;
  offsetChanged?: boolean;
  interruptedJobs: number;
  orphanedQueued: number;
  orphanedRetryWaiting: number;
  jobsReplayedFromRun: number;
  pruned: number;
  /** Always 0: a durable dedup key makes a replayed alert impossible. */
  notificationsReplayed: 0;
}

export interface AgentBrowserAPI {
  profile: {
    list: () => Promise<any[]>;
    get: (dirId: string) => Promise<any>;
    // Round 3 D1: the live channel is browser:create (preload routes
    // profile.create there); the gate refusal union must be visible.
    create: (name: string, options?: any) => Promise<{ dirId: string } | { success: false; error: string; code?: string }>;
    delete: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    // R9 P3-3: soft-delete channel the UI deletes through (7-day trash).
    trash: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    trashRestore: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    trashList: () => Promise<{ success: boolean; entries: Array<{ dirId: string; name: string; deletedAt: number; recoverable: boolean; incomplete: boolean; recoveryRequired: boolean }>; error?: string }>;
    trashPurge: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    rename: (dirId: string, name: string) => Promise<{ success: boolean; error?: string }>;
    exportArchive: (dirId: string, destPath?: string, options?: { overwrite?: boolean }) => Promise<{ success: boolean; outcome?: "completed" | "failed" | "cancelled"; cancelled?: boolean; code?: string; filePath?: string; entries?: number; bytes?: number; warnings?: string[]; error?: string }>;
    importArchive: (zipPath?: string) => Promise<{ success: boolean; outcome?: "completed" | "failed" | "cancelled"; cancelled?: boolean; code?: string; dirId?: string; name?: string; files?: number; bytes?: number; warnings?: string[]; error?: string }>;
    exportArchives: (dirIds: string[], destDir?: string, options?: { overwrite?: boolean }) => Promise<{ success: boolean; outcome?: "completed" | "partial" | "skipped" | "failed" | "cancelled"; cancelled?: boolean; code?: string; report?: { exported: Array<{ dirId: string; filePath: string; entries: number; bytes: number; warnings?: string[] }>; skipped: Array<{ dirId: string; reason: string }>; failed: Array<{ dirId: string; error: string; code?: string }> }; error?: string }>;
    importArchives: (zipPaths?: string[]) => Promise<{ success: boolean; outcome?: "completed" | "partial" | "skipped" | "failed" | "cancelled"; cancelled?: boolean; code?: string; report?: { imported: Array<{ zipPath: string; dirId: string; name: string; files: number; bytes: number; warnings: string[] }>; failed: Array<{ zipPath: string; error: string; code?: string }> }; error?: string }>;
    cookies: (dirId: string, filter?: string) => Promise<any[]>;
    setCookie: (dirId: string, cookie: any) => Promise<{ success: boolean; error?: string }>;
    deleteCookie: (dirId: string, domain: string, name: string) => Promise<{ success: boolean; error?: string }>;
  };
  proxy: {
    list: () => Promise<Array<{ name: string; config: RedactedProxyConfig; isDefault: boolean; detection?: ProxyDetectionCacheEntry }>>;
    get: (name: string) => Promise<RedactedProxyConfig | null>;
    getProfile: (dirId: string) => Promise<ResolvedProfileProxy>;
    add: (name: string, config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
    delete: (name: string) => Promise<{ success: boolean; error?: string }>;
    update: (name: string, config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
    rename: (oldName: string, newName: string, config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
    setDefault: (name: string) => Promise<{ success: boolean; error?: string }>;
    setProfile: (dirId: string, proxyName: string | null, mode?: ProxyMode) => Promise<{ success: boolean; error?: string }>;
    healthGet: () => Promise<{ entries: ProxyHealthEntry[]; summary: ProxyHealthSummary }>;
    healthClear: (name?: string) => Promise<{ success: boolean; error?: string; cleared?: number }>;
    rotate: (name: string) => Promise<{ success: boolean; error?: string; info?: { from: string; to: string | null; reason: string | null; active: boolean } }>;
    rotationInfo: (name: string) => Promise<{ success: boolean; error?: string; info?: { from: string; to: string | null; reason: string | null; active: boolean } }>;
  };
  detect: {
    proxy: (config: ProxyConfig) => Promise<ProxyDetectionResult>;
    proxyPing: (config: ProxyConfig) => Promise<{ success: boolean; latencyMs: number | null; error: string | null }>;
    proxyByName: (name: string) => Promise<Partial<ProxyDetectionResult> & { success: boolean; code?: "PROXY_DETECTION_TARGET_CHANGED" | "PROXY_DETECTION_STALE" | "PROXY_DETECTION_UNOBSERVED" | "PROXY_DETECTION_SAVE_FAILED" }>;
    webrtcLeak: (config: ProxyConfig) => Promise<any>;
  };
  storage: {
    info: () => Promise<any>;
    clearCache: (dirId?: string) => Promise<any>;
    availableDisk: () => Promise<any>;
  };
  sync: {
    push: (opts?: { force?: boolean; comparisonToken?: SyncComparisonToken; history?: boolean }) => Promise<SyncResult>;
    pull: (opts?: { strategy?: "local" | "remote" | "newest"; resolutions?: Record<string, "local" | "remote" | "newest">; comparisonToken?: SyncComparisonToken; history?: boolean; allowRunningPartial?: boolean }) => Promise<SyncResult>;
    status: () => Promise<{ enabled: boolean; configured: boolean; endpoint: string; bucket: string; accessKeyMasked: string; custodyConsentAt: number | null;
      includeHistory?: boolean; historyConsentAt?: number | null;
      includeFullProfile: boolean; fullProfileConsentAt: number | null; fullProfilePassphraseSet: boolean;
      operation: { generation: number; active: ActiveSyncOperation | null; last: SyncResult | null } }>;
    preview: () => Promise<{ configured: boolean; profiles: number; runningProfiles: string[]; proxies: number; accounts: number; extensions: number; message: string }>;
    previewDiff: () => Promise<SyncDiffResult>;
    configure: (config: Partial<Pick<SyncConfig, "enabled" | "endpoint" | "bucket" | "accessKey" | "secretKey" | "includeHistory" | "includeFullProfile" | "fullProfilePassphrase">> & {
      custodyConsent?: boolean; historyConsent?: boolean; fullProfileConsent?: boolean;
    }) => Promise<{ success: boolean; error?: string; code?: string }>;
  };
  app: {
    /** Acknowledges an exit request; actual termination must be observed separately. */
    quit: () => Promise<{ success: boolean }>;
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
    // M3: terminal-notification preferences. Both default false — the in-app
    // record is always kept, and the OS banner is opt-in.
    automationNotify: () => Promise<{ system: boolean; sound: boolean }>;
    setAutomationNotify: (prefs: { system?: boolean; sound?: boolean }) => Promise<{ success: boolean; automationNotify: { system: boolean; sound: boolean } }>;
  };
  mcp: {
    status: () => Promise<any>;
    restart: () => Promise<any>;
    revealToken: () => Promise<{ token: string | null }>;
  };
  browser: {
    list: () => Promise<BrowserProfileInfo[]>;
    binary: () => Promise<ManagedChromiumStatus>;
    engineStatus: () => Promise<{ chromium: ManagedChromiumStatus; firefox: FirefoxStatus }>;
    verifyBinary: () => Promise<{ success: boolean; status: ManagedChromiumStatus; error?: string }>;
    create: (opts: any) => Promise<{ dirId: string } | { success: false; error: string; code?: string }>;
    delete: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    launch: (dirId: string, opts?: { forceDeadProxy?: boolean }) => Promise<{ success: boolean; pid?: number; cdpPort?: number; error?: string; code?: string; driftCheck?: LaunchDriftCheck; cookieCheck?: { checked: boolean; applied?: number; pending?: number; error?: string } }>;
    stop: (dirId: string) => Promise<{ success: boolean; error?: string }>;
    status: (dirId: string) => Promise<{ running: boolean; unknown?: boolean; stopping?: boolean; pid?: number | null; cdpPort?: number | null; error?: string }>;
    setSeed: (dirId: string, seed: number) => Promise<{ success: boolean }>;
    setMeta: (dirId: string, meta: any) => Promise<{ success: boolean }>;
    openRiskCheck: (dirId: string, opts?: { allowLaunch?: boolean; url?: string }) => Promise<{ success: boolean; error?: string; code?: string; autoLaunched?: boolean }>;
    envRisk: (dirId: string, options?: { requestId?: string }) => Promise<HealthResponse<EnvRiskResult>>;
    envRiskHistory: (dirId: string) => Promise<{ ok: boolean; entries: EnvRiskDiagnosticsEntry[] | null; code?: string; error?: string }>;
    envRiskClear: (dirId: string) => Promise<{ ok: boolean; code?: string; error?: string }>;
    /** Authoritative main-process history; renderer localStorage is only a cache. */
    healthHistory: (dirId: string) => Promise<{ entries: ProfileHealthEntry[] | null; ok?: boolean; outcome?: ProfileHealthOutcome; code?: string; error?: string }>;
    /** Acknowledges a request; cancelled=true is not evidence that the run settled or the browser stopped. */
    healthCancel: (dirId: string, options: { kind: ProfileHealthKind; requestId: string }) => Promise<{ success: boolean; cancelled: boolean; code?: string }>;
    healthClear: (dirId: string, kind?: ProfileHealthKind) => Promise<{ ok: boolean; code?: string }>;
    /** Lists already-owned HTTP(S) pages; does not start an observation or browser. */
    networkPages: (dirId: string) => Promise<ProfileNetworkPagesResult>;
    networkObserve: (dirId: string, options: { selection: string; requestId: string }) => Promise<ProfileNetworkObservationResult>;
    onNetworkArmed: (callback: (event: ProfileNetworkArmedEvent) => void) => () => void;
    consistencyCheck: (dirId: string) => Promise<Omit<HealthResponse<never>, "result"> & { warnings?: Array<{ severity: string; code: string; message: string }>; blockers?: Array<{ severity: string; code: string; message: string }> }>;
    checkDrift: (dirId: string) => Promise<FingerprintDriftCheckResult>;
    driftReport: (dirId: string) => Promise<{ ok: boolean; report: FingerprintComparisonReport | null; currentConfigMatches: boolean; canUpdateBaseline: boolean; code?: string; warning?: string; error?: string }>;
    captureBaseline: (dirId: string, options?: { confirmationToken?: string; reportId?: string }) => Promise<BaselineCaptureResult>;
    resetBaseline: (dirId: string, options?: { confirmationToken?: string }) => Promise<BaselineResetResult>;
    setLock: (dirId: string, locked: boolean) => Promise<{ success: boolean; error?: string }>;
    openApp: (dirId: string, url?: string) => Promise<{ success: boolean; error?: string; code?: string; appUrl?: string }>;
    logs: (dirId: string) => Promise<any>;
    selectBinary: () => Promise<{ success: boolean; path?: string; cancelled?: boolean; error?: string }>;
    batchLaunch: (dirIds: string[], concurrency?: number, jobId?: string) => Promise<any>;
    batchStop: (dirIds: string[], concurrency?: number, jobId?: string) => Promise<any>;
    batchCancel: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    batchMaxConcurrency: () => Promise<{ max: number }>;
    parseBulkCsv: (text: string) => Promise<{ ok: boolean; specs?: any[]; error?: string }>;
  };
  webrtc: {
    diag: (dirId: string, options?: { allowLaunch?: boolean; requestId?: string }) => Promise<HealthResponse<WebRtcDiagnosticsEntry>>;
    diagHistory: (dirId: string) => Promise<{ entries: WebRtcDiagnosticsEntry[] | null; ok?: boolean; outcome?: ProfileHealthOutcome; code?: string; error?: string }>;
    diagClear: (dirId: string) => Promise<{ success: boolean; code?: string; error?: string }>;
  };
  agent: {
    llmConfig: () => Promise<RedactedLlmConfig | null>;
    detectLlmConfig: () => Promise<RedactedLlmConfig | null>;
    saveLlmConfig: (config: { provider: "openai" | "claude" | "custom"; apiKey?: string; apiUrl?: string; model?: string }) => Promise<{ success: boolean; error?: string }>;
    chat: (conversationId: string, message: string, options?: { profileDirId?: string; requestId?: string }) => Promise<AgentStreamTerminal>;
    chatStream: (conversationId: string, message: string, streamId?: string, options?: { profileDirId?: string; requestId?: string }) => Promise<AgentStreamTerminal>;
    cancelRun: (params: { conversationId: string; runId?: string; streamId?: string }) => Promise<AgentCancelResult>;
    activeRun: (conversationId: string) => Promise<AgentActiveRunSnapshot | null>;
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
    platformAdapters: {
      list: (filter?: string) => Promise<PlatformAdapterSummary[]>;
      get: (id: string) => Promise<PlatformAdapter | null>;
      detect: (url: string) => Promise<PlatformAdapter | null>;
    };
    conversations: {
      list: () => Promise<AgentConversationSummary[]>;
      get: (id: string) => Promise<AgentConversation | null>;
      create: (title?: string) => Promise<AgentConversationSummary>;
      delete: (id: string) => Promise<{ success?: boolean } | boolean>;
      rename: (id: string, title: string) => Promise<AgentConversation | null>;
    };
    accounts: {
      list: () => Promise<RedactedPlatformAccount[]>;
      get: (index: number, ref: AccountReference) => Promise<RedactedPlatformAccount>;
      add: (account: { platformUrl: string; platformUserName: string; platformPassword: string; profileIds?: string[]; tags?: string[] }) => Promise<RedactedPlatformAccount>;
      update: (index: number, account: Partial<{ platformUrl: string; platformUserName: string; platformPassword: string; profileIds: string[]; tags: string[] }>, ref: AccountReference) => Promise<RedactedPlatformAccount>;
      delete: (index: number, ref: AccountReference) => Promise<boolean>;
      forProfile: (dirId: string) => Promise<RedactedPlatformAccount[]>;
      bind: (index: number, profileIds: string[], ref: AccountReference) => Promise<RedactedPlatformAccount>;
      copyUsername: (index: number, ref: AccountReference) => Promise<{ ok: boolean; error?: string }>;
      copyPassword: (index: number, ref: AccountReference) => Promise<{ ok: boolean; error?: string }>;
      bulkAdd: (text: string) => Promise<{ added: number; skipped: number }>;
      bulkCreate: (text: string, options?: { platform?: string; startUrl?: string }) => Promise<{ added: number; created: number; skipped: number; errors: string[] }>;
    };
  };
  automation: {
    list: () => Promise<any[]>;
    create: (rule: any) => Promise<{ success: boolean; rule?: any; error?: string }>;
    update: (rule: any) => Promise<{ success: boolean; rule?: any; error?: string }>;
    delete: (ruleId: string) => Promise<{ success: boolean; error?: string }>;
    testRun: (ruleId: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
    retryRun: (runId: string) => Promise<{ success: boolean; error?: string }>;
    retryJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    logs: () => Promise<any[]>;
    validateCron: (expr: string) => Promise<{ valid: boolean; error?: string }>;
    jobs: (opts?: { status?: string; limit?: number }) => Promise<any[]>;
    jobGet: (id: string) => Promise<any>;
    jobCancel: (id: string) => Promise<{ success: boolean; error?: string }>;
    // M3: schedule state lives on its own channel, never merged into list().
    // The rule object is round-tripped by the editor and by automationToggle,
    // so mixing display fields into it would give a badge a path into config.
    scheduleState: () => Promise<{ success: boolean; states?: RuleScheduleState[]; error?: string }>;
    rescheduleOnce: (params: { ruleId: string; at: number }) => Promise<{ success: boolean; rule?: any; error?: string }>;
    reconcile: () => Promise<ReconcileReport>;
    notifications: (opts?: { limit?: number; unreadOnly?: boolean }) => Promise<StoredNotification[]>;
    notificationsRead: (keys: string[]) => Promise<{ success: boolean; changed?: number }>;
    notificationsUnreadCount: () => Promise<number>;
  };
  agentRuns: {
    list: () => Promise<AgentRun[]>;
    get: (runId: string) => Promise<AgentRun | null>;
    delete: (runId: string) => Promise<{ success: boolean; reasonCode?: "active" | "missing"; error?: string }>;
    clear: () => Promise<{ success: boolean; deleted: number; skipped: number; error?: string }>;
    resultsPreview: (params: { runId: string; artifactId?: string; offset?: number; limit?: number }) =>
      Promise<({ ok: true } & AgentRunResultsPreview) | { ok: false; error: string; reasonCode?: string }>;
    exportPlan: (params: { runId: string; artifactId?: string; kind: AgentRunExportKind }) =>
      Promise<{ ok: true; plan: AgentRunExportPlan } | { ok: false; error: string; reasonCode?: string }>;
    exportWrite: (params: { runId: string; artifactId?: string; kind: AgentRunExportKind; destPath?: string }) =>
      Promise<{ ok: true; filePath: string; bytes: number; rows?: number } | { ok: false; error: string; reasonCode?: string }>;
  };
  approval: {
    list: () => Promise<Array<{
      id: string;
      runId?: string;
      category: "db-write" | "db-destroy" | "fs-write" | "http-write";
      tool: string;
      description: string;
      detail?: string;
      createdAt: number;
    }>>;
    resolve: (id: string, decision: "once" | "always" | "deny", opts: { confirmed: true }) => Promise<{ success: boolean; error?: string }>;
  };
  license: {
    status: () => Promise<{
      plan: string; trialStartedAt: number | null; trialDays: number;
      licensedTo: string | null; expiresAt: number | null; maxProfiles: number | null;
      deviceId: string; daysLeft: number; expired: boolean; canActivate: boolean;
    }>;
    activate: (code: string) => Promise<{ ok: boolean; state?: any; code?: string; error?: string }>;
  };
  data: {
    /** Structured JSON export. An unknown scope fails explicitly (M2) rather
     *  than returning an empty object that reads as "no data". */
    export: (scope: string) => Promise<
      { ok: true; scope: string; exportedAt: number; data: any }
      | { ok: false; error: string; allowed?: readonly string[] }
    >;
  };
  on: (channel: string, callback: (...args: any[]) => void) => void;
  removeListener: (channel: string, callback: (...args: any[]) => void) => void;
}

export interface PlatformAdapterRecipe {
  name: string;
  goal: string;
  steps: string[];
}

export interface PlatformAdapterSummary {
  id: string;
  name: string;
  category: string;
  regions: string[];
  presets: string[];
  pitch: string;
  domains: string[];
  selectorVersion: number;
  capabilities: string[];
  loginUrlHints: string[];
  recipes: PlatformAdapterRecipe[];
  notes: string;
  lastVerifiedAt: string;
}

export interface PlatformAdapter extends PlatformAdapterSummary {
  selectors: Record<string, string[]>;
  loginCheck: string;
  collectMetrics?: string;
}

declare global {
  interface Window {
    agentBrowserAPI?: AgentBrowserAPI;
    agentBrowser?: any;
  }
}

export {};
