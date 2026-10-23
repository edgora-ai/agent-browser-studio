// REST success contracts used by the SDK. Generic requests deliberately remain
// unknown: readJson also returns {} for an empty body or { raw } for non-JSON.
// These declarations describe the controller protocol, not runtime validation.
import type { Browser } from 'playwright-core';
import type { AgentRun, LlmConfig, SyncResult, SyncConfig, SyncComparisonToken, ProfileHistorySyncState } from '../../src/main/types.js';
export type SyncHistoryOptions = { history?: boolean; comparisonToken?: SyncComparisonToken };
export type SyncSettings = Pick<Partial<SyncConfig>, 'enabled' | 'endpoint' | 'bucket' | 'accessKey' | 'secretKey' | 'includeHistory' | 'includeFullProfile' | 'fullProfilePassphrase'> & { custodyConsent?: boolean; historyConsent?: boolean; fullProfileConsent?: boolean };
export type SyncStatus = { enabled: boolean; configured: boolean; endpoint: string; bucket: string; accessKeyMasked: string;
  includeHistory: boolean; custodyConsentAt: number | null; historyConsentAt: number | null; history: Record<string, ProfileHistorySyncState>;
  includeFullProfile: boolean; fullProfileConsentAt: number | null; fullProfilePassphraseSet: boolean; operation: unknown };
import type { Conversation } from '../../src/main/services/agent/conversation-store.js';
import type { QueryResult, TableInfo } from '../../src/main/services/agent-db.js';
import type { ApprovalRequest, ApprovalDecision } from '../../src/main/services/approval-gate.js';

export interface AgentBrowserErrorOptions {
  status?: number;
  body?: unknown;
  bodyTruncated?: boolean;
  bodyReadError?: string;
}
export class AgentBrowserError extends Error {
  constructor(message: string, options?: AgentBrowserErrorOptions);
  status?: number;
  /** Complete JSON (or { raw } for non-JSON), bounded to 2 MiB. Undefined when truncated/unavailable. */
  body?: unknown;
  bodyTruncated: boolean;
  bodyReadError?: string;
}
export interface ClientOptions { token?: string; timeout?: number }
export type RequestHeaders = Record<string, string>;
export type Query = Record<string, string>;
export type RedactedLlmConfig = Omit<LlmConfig, 'apiKey'> & { hasApiKey?: boolean; apiKey?: never };
export type ConversationSummary = Omit<Conversation, 'messages'> & { messageCount: number };
export interface ProfileSummary {
  dirId: string;
  name: string;
  engine: 'chromium' | 'firefox';
  browser: 'chromium' | 'firefox';
  running: boolean;
  proxyMode: unknown;
  proxy: string | null;
  version: string;
  tags: string[];
  syncedAt: number | null;
  syncStatus: 'synced' | 'dirty' | 'never' | 'unknown';
  syncScope: 'portable-profile+preferences';
  syncReason: 'baseline-match' | 'content-changed' | 'no-baseline' | 'legacy-marker' |
    'invalid-baseline' | 'target-mismatch' | 'target-unavailable' |
    'preferences-unavailable' | 'content-unavailable';
}
export interface AgentBrowserClient {
  // Unreviewed response payloads are intentionally unknown, never wildcard any.
  getProfile(dirId: string): Promise<unknown>;
  deleteProfile(dirId: string): Promise<unknown>;
  launchProfile(dirId: string, opts?: { headless?: boolean }): Promise<unknown>;
  stopProfile(dirId: string): Promise<unknown>;
  profileStatus(dirId: string): Promise<unknown>;
  listProxies(): Promise<unknown>;
  addProxy(name: string, config: unknown): Promise<unknown>;
  deleteProxy(name: string): Promise<unknown>;
  teamStatus(): Promise<unknown>;
  teamInit(name: string): Promise<unknown>;
  teamAddMember(deviceId: string, role: string, name?: string): Promise<unknown>;
  teamRemoveMember(deviceId: string): Promise<unknown>;
  drmStatus(): Promise<unknown>;
  serverIdle(): Promise<unknown>;
  automationRules(): Promise<unknown>;
  runs(query?: Query): Promise<unknown>;
  jobs(query?: Query): Promise<unknown>;
  listSkills(filter?: string): Promise<unknown>;
  installSkill(skillId: string): Promise<unknown>;
  deleteSkill(skillId: string): Promise<unknown>;
}
export class AgentBrowserClient {
  constructor(baseUrl?: string, options?: ClientOptions);
  baseUrl: string;
  token: string;
  timeout: number;
  headers(hasBody: boolean, requestHeaders?: RequestHeaders): RequestHeaders;
  request(method: string, path: string, body?: unknown, requestHeaders?: RequestHeaders): Promise<unknown>;
  get(path: string, headers?: RequestHeaders): Promise<unknown>;
  post(path: string, body?: unknown, headers?: RequestHeaders): Promise<unknown>;
  delete(path: string, headers?: RequestHeaders): Promise<unknown>;
  put(path: string, body?: unknown, headers?: RequestHeaders): Promise<unknown>;
  patch(path: string, body?: unknown, headers?: RequestHeaders): Promise<unknown>;
  // rest-api-server.ts:232-284, 1162-1383.
  health(): Promise<{ status: string; service: string; port: number; mode: 'headless' | 'gui'; version: string; profiles: number; uptimeSeconds: number }>;
  version(): Promise<{ name: string; slug: string; version: string; chromium: { path: string | null; version: string | null } }>;
  openapi(): Promise<{ paths: Record<string, unknown> }>;
  syncStatus(): Promise<SyncStatus>;
  configureSync(settings: SyncSettings): Promise<{ success: boolean } & Partial<SyncStatus>>;
  syncPush(options?: SyncHistoryOptions & { force?: boolean }): Promise<SyncResult>;
  syncPull(options?: SyncHistoryOptions & { strategy?: 'local' | 'remote' | 'newest'; resolutions?: Record<string, 'local' | 'remote' | 'newest'> }): Promise<SyncResult>;
  syncHistoryState(dirId: string): Promise<{ dirId: string } & ProfileHistorySyncState>;
  listProfiles(): Promise<ProfileSummary[]>;
  createProfile(name: string, options?: Record<string, unknown>): Promise<{ success: boolean; dirId: string }>;
  llmConfig(): Promise<{ config: RedactedLlmConfig | null }>;
  saveLlmConfig(config: LlmConfig): Promise<{ success: boolean; config: RedactedLlmConfig | null }>;
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(title?: string): Promise<{ success: boolean; conversation: ConversationSummary }>;
  getConversation(conversationId: string): Promise<{ conversation: Conversation }>;
  renameConversation(conversationId: string, title: string): Promise<{ success: boolean; conversation: ConversationSummary }>;
  deleteConversation(conversationId: string): Promise<{ success: boolean }>;
  chatSimple(messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>): Promise<{ reply: string }>;
  chat(conversationId: string, message: string, timeoutMs?: number): Promise<{ reply: string; toolCalls: Array<{ name: string; redacted: boolean }>; runId: string; conversationId: string }>;
  agentRuns(query?: Query): Promise<AgentRun[]>;
  agentRun(runId: string): Promise<{ run: AgentRun }>;
  deleteAgentRun(runId: string): Promise<{ success: boolean }>;
  clearAgentRuns(): Promise<{ success: boolean; deleted: number; skipped: number }>;
  dbTables(): Promise<TableInfo[]>;
  dbTable(table: string, query?: Query): Promise<{ rows: unknown[]; total: number; columns: string[] }>;
  dbQuery(sql: string): Promise<QueryResult & { ok: boolean }>;
  dbExec(sql: string): Promise<{ success: boolean }>;
  pendingApprovals(): Promise<ApprovalRequest[]>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<unknown>;
}

// agent-browser.mjs:271-297 passes precisely these profile options through.
export interface ConnectOptions extends ClientOptions {
  baseUrl?: string;
  dirId?: string;
  name?: string;
  cdpTimeoutMs?: number;
  headless?: boolean;
  platform?: string;
  fingerprintSeed?: number;
  timezone?: string;
  locale?: string;
  webrtcMode?: string;
  webrtcIp?: string;
  geolocationMode?: string;
  geolocationLatitude?: number;
  geolocationLongitude?: number;
  geolocationAccuracy?: number;
  gpuVendor?: string;
  gpuRenderer?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screenWidth?: number;
  screenHeight?: number;
  storageQuota?: number;
  taskbarHeight?: number;
  fontsDir?: string;
  drm?: boolean;
  tags?: string[];
  browserVersion?: string;
  fingerprintMode?: string;
  proxyMode?: string;
  proxyName?: string;
}
export interface BrowserHandle<B> {
  browser: B;
  client: AgentBrowserClient;
  // Creation returns { success, dirId }; attach returns a detailed profile.
  profile: unknown;
  dirId: string;
  cdpPort: number;
  webSocketDebuggerUrl: unknown;
  stop(): Promise<void>;
}
export function connectPlaywright(options?: ConnectOptions): Promise<BrowserHandle<Browser>>;
// No Puppeteer peer dependency is required to type the REST client. Only the
// shared close operation is promised here; its driver-specific API is opaque.
export function connectPuppeteer(options?: ConnectOptions): Promise<BrowserHandle<{ close(): Promise<void> }>>;
