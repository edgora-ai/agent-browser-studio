import { createHash, createHmac, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { spawn } from "node:child_process";
import { getSyncConfig, getConfig, getConfigPath, saveConfig, getProfilesDir, getAppDataDir, portableProfileContent } from "./config-manager.js";
import { transact } from "./config/store.js";
import { DEFAULT_SYNC_LIMITS } from "./sync/limits.js";
import type { ArtifactHandler } from "./sync/artifacts/interface.js";
import { runtimeCookieOps } from "./bidi-cookie-service.js";
import { writeQueuedCookieImports, readQueuedCookieImports, normalizeCookieForQueue } from "./cdp-cookie-service.js";
import { acquireRestoreLock, isRestoreLocked, assertProfileTransferStopped, beginFullProfileRecovery, finishFullProfileRecovery, type FullProfileRecoveryTicket } from "./profile-restore-lock.js";
import { markProfileDataChanging } from "./profile-data-revision.js";
import { decryptSecretOr } from "./secrets.js";
import { sanitizeTeam, mergeTeam, requireSyncPush, requireForcePush, requireSettingsMutation } from "./team.js";
import { statusBrowser } from "./browser-manager.js";
import { validateDirId } from "./utils.js";
import { listExtensionRepository, getExtensionRepoEntryDir, prepareSyncedExtensionPackage, restoreSyncedExtensionPackage } from "./extension-repository.js";
import { tMain } from "./main-i18n.js";
import type { SyncConfig, MgmtConfig, CookieInfo, ProxyConfig, SyncResult, SyncItemResult, SyncComparisonToken, SyncProfileRuntimeEffect } from "../types.js";
import { SyncOperationResult } from "./sync/operation-result.js";
import { beginSyncOperation, getSyncOperationState } from "./sync/operation-state.js";
import { createProfileSyncBaseline, getProfileSyncTarget, parseProfileSyncBaseline, profileContentHash, profilePreferencesSnapshot, profileHistoryCoverage, readProfileHistorySyncState } from "./sync/profile-state.js";
import type { ProfilePreferencesSnapshot, ExtensionRepositoryEntry } from "../types.js";
import { PORTABLE_PROFILE_FIELDS, parseHistoryCoverage } from "./profile-portability.js";
import type { BrowserEngine, HistoryCoverage } from "../types.js";
import { captureHistory, historyBaseline, historyPath, historyBasename, historySidecars, makeHistoryArtifact, prepareHistoryArtifact, MAX_HISTORY_OBJECT_BYTES, MAX_SYNC_HISTORY_BYTES, type PreparedHistory } from "./sync/sqlite-history.js";
import { sqliteGroupWitnesses } from "./sync/sqlite-local-storage.js";
import { captureSqliteLocalStorage, hasSqliteLocalStorage, validateSqliteLocalStorageGroup, validateStagedSqliteLocalStorage, writeOwnedSqliteFile, SQLITE_LOCAL_STORAGE_FILES, SQLITE_LOCAL_STORAGE_SIDECARS } from "./sync/sqlite-local-storage.js";
import { syncArchiveDirectory } from "./zip-writer.js";
import { compareProfileIdentity } from "./profile-identity.js";

export type { SyncResult } from "../types.js";

type SyncSafeConfig = Omit<MgmtConfig, "sync" | "proxies"> & {
  sync: Omit<SyncConfig, "accessKey" | "secretKey" | "fullProfilePassphrase">;
  proxies: Record<string, Omit<ProxyConfig, "username" | "password">>;
};

const SYNC_CONFIG_KEY = "agent-browser-studio-config.json";
const LEGACY_SYNC_CONFIG_KEY = "cloak-lite-config.json";
const MAX_REMOTE_PAYLOAD_JSON_BYTES = 150 * 1024 * 1024;
const MAX_CONFIG_GZIP_BYTES = 10 * 1024 * 1024;
const MAX_CONFIG_JSON_BYTES = 25 * 1024 * 1024;
const MAX_COOKIES_GZIP_BYTES = 5 * 1024 * 1024;
const MAX_COOKIES_JSON_BYTES = 25 * 1024 * 1024;
const MAX_EXTENSION_PACKAGE_BYTES = 80 * 1024 * 1024;
const MAX_SYNC_EXTENSIONS = 50;
const MAX_PULL_EXTENSION_BYTES = 500 * 1024 * 1024;
const EXTENSION_HASH_RE = /^[0-9a-f]{128}$/i;
const MAX_COOKIE_COUNT = 20000;
const MAX_SYNC_PROFILES = 200;
const MAX_PULL_LOCAL_STORAGE_ARCHIVES = 200;
const MAX_PULL_LOCAL_STORAGE_BYTES = 500 * 1024 * 1024;
const MAX_PULL_COOKIES = 50000;
const MAX_PULL_PREFERENCES_BYTES = 50 * 1024 * 1024;
const MAX_PREFERENCES_GZIP_BYTES = 2 * 1024 * 1024;
const MAX_PREFERENCES_JSON_BYTES = 10 * 1024 * 1024;
const MAX_LOCAL_STORAGE_TGZ_BYTES = 50 * 1024 * 1024;
const MAX_LOCAL_STORAGE_TAR_BYTES = 200 * 1024 * 1024;
const MAX_LOCAL_STORAGE_FILES = 5000;

function assertSyncNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Sync operation cancelled");
}

function assertSyncRole(kind: "push" | "pull", force = false): void {
  const gate = kind === "pull" ? requireSettingsMutation() : force ? requireForcePush() : requireSyncPush();
  if (!gate.ok) throw Object.assign(new Error(`Sync ${kind} blocked by team policy: ${gate.error}`), { code: "TEAM_ROLE_DENIED" });
}

export const syncService = {
  // ── Preview (offline pre-flight: what a push would involve + who'd skip on pull) ──
  preview(): { configured: boolean; profiles: number; runningProfiles: string[]; proxies: number; accounts: number; extensions: number; message: string } {
    const cfg = getConfig() as any;
    const sync = getSyncConfig();
    const profileIds = Object.keys(cfg.browserProfiles || {});
    const runningProfiles: string[] = [];
    for (const dirId of profileIds) {
      if (isProfileRunningForRestore(dirId)) runningProfiles.push(dirId);
    }
    let extensions = 0;
    try { extensions = listExtensionRepository().length; } catch { /* ignore */ }
    const configured = Boolean(sync.enabled && sync.endpoint && sync.bucket);
    const skipNote = runningProfiles.length
      ? `（${runningProfiles.length} 个运行中或退出未确认，pull 时整项跳过；需先停止并确认浏览器退出）`
      : "";
    return {
      configured,
      profiles: profileIds.length,
      runningProfiles,
      proxies: Object.keys(cfg.proxies || {}).length,
      accounts: (cfg.accounts || []).length,
      extensions,
      message: configured
        ? `将同步 ${profileIds.length} 个 profile${skipNote}`
        : `同步未配置 (endpoint/bucket/enabled)${skipNote}`,
    };
  },
  // ── Diff preview (remote vs local, read-only) ──
  async previewDiff(): Promise<SyncDiffResult> {
    const sync = structuredClone(getSyncConfig());
    if (!sync.enabled || !sync.endpoint || !sync.bucket) {
      return { ok: false, message: "Sync not enabled or configured", ...emptySyncDiff() };
    }
    try {
      const fetched = await fetchSyncConfig(sync);
      if (!fetched.ok) {
        if (fetched.message.startsWith("HTTP 404")) {
          const localSnapshot = sanitizeConfigForSync(cloneConfig(getConfig())) as any;
          const body = buildSyncDiff(localSnapshot, { browserProfiles: {}, proxies: {}, extensionRepository: {}, accounts: [] } as any, {}, getConfig().deviceId);
          return { ok: true, firstPush: true, remoteTimestamp: null,
            comparisonToken: createComparisonToken(sync, localSnapshot, null),
            coverage: compareProfilePreferences(body.profiles, localSnapshot.browserProfiles || {}, {}, {}), ...body };
        }
        return { ok: false, message: fetched.message, ...emptySyncDiff() };
      }
      const payload = fetched.payload;
      const raw = gunzipBase64Field(payload.data, MAX_CONFIG_GZIP_BYTES, MAX_CONFIG_JSON_BYTES, "sync config");
      const remoteConfig = sanitizeRemoteConfig(JSON.parse(raw.toString()) as MgmtConfig);
      validateArtifactProfileIds(payload, new Set(Object.keys(remoteConfig.browserProfiles || {})));
      parseRemoteHistory(payload, remoteConfig.browserProfiles || {});
      const localSnapshot = sanitizeConfigForSync(cloneConfig(getConfig())) as any;
      const body = buildSyncDiff(localSnapshot, remoteConfig as any, payload, getConfig().deviceId);
      const coverage = compareProfilePreferences(body.profiles, localSnapshot.browserProfiles || {}, remoteConfig.browserProfiles || {}, payload);
      return {
        ok: true,
        coverage,
        comparisonToken: createComparisonToken(sync, localSnapshot, payload),
        remoteTimestamp: typeof payload.timestamp === "number" ? payload.timestamp : null,
        ...body,
      };
    } catch (e: any) {
      return { ok: false, message: e.message || String(e), ...emptySyncDiff() };
    }
  },
  // ── Push ──
  async push(signal?: AbortSignal, force = false, comparisonToken?: SyncComparisonToken, opts?: SyncHistoryOptions): Promise<SyncResult> {
    assertSyncNotAborted(signal);
    const sync = getSyncConfig();
    if (!sync.enabled || !sync.endpoint || !sync.bucket) {
      return { success: false, message: "Sync not enabled or configured" };
    }
    // Sale-93 data-custody consent: uploading cookies/sessions requires the
    // separate in-app consent (timestamped by the main process). Fail closed.
    if (typeof (sync as any)?.custodyConsentAt !== "number" || (sync as any).custodyConsentAt <= 0) {
      return { success: false, message: "Sync data-custody consent required: tick the data-custody consent box and save first", code: "CUSTODY_CONSENT_REQUIRED" };
    }

    // Team workspace RBAC: viewers are read-only; force push needs admin+.
    const pushGate = force ? requireForcePush() : requireSyncPush();
    if (!pushGate.ok) {
      return { success: false, code: "TEAM_ROLE_DENIED", message: "Push blocked by team policy: " + pushGate.error };
    }

    try { historySelected(sync, opts); }
    catch (error) { return { success: false, message: (error as Error).message, code: (error as any).code || "INVALID_HISTORY_SCOPE" }; }
    return sync.includeFullProfile
      ? pushFullProfileSnapshot(structuredClone(sync), force, signal, comparisonToken, opts)
      : pushFrozenSnapshot(structuredClone(sync), force, signal, comparisonToken, opts);
  },

  // ── Pull ──
  async pull(signal?: AbortSignal, opts?: SyncPullOptions): Promise<SyncResult> {
    assertSyncNotAborted(signal);
    const sync = structuredClone(getSyncConfig());
    let stageRoot: string | undefined;
    let finalResult: SyncResult | undefined;
    const createdProfileIds = new Set<string>();
    if (!sync.endpoint || !sync.bucket) {
      return { success: false, message: "Endpoint and bucket required" };
    }
    // Sale-93: pulling writes remote cookies/sessions into local profiles —
    // same custody consent as push.
    if (typeof (sync as any)?.custodyConsentAt !== "number" || (sync as any).custodyConsentAt <= 0) {
      return { success: false, message: "Sync data-custody consent required: tick the data-custody consent box and save first", code: "CUSTODY_CONSENT_REQUIRED" };
    }

    const pullGate = requireSettingsMutation();
    if (!pullGate.ok) return { success: false, code: "TEAM_ROLE_DENIED", message: "Pull blocked by team policy: " + pullGate.error };
    if (sync.includeFullProfile) return pullFullProfileSnapshot(sync, signal, opts);
    const lease = beginSyncOperation("pull");
    if ("busy" in lease) return lease.busy;
    const operation = lease.operation;
    const historyRollbacks: Array<() => void> = [];
    const profileLocks = new Map<string, () => void>();
    const profileReceipts = new Map<string, SyncItemResult>();
    const allowRunningPartial = Boolean(opts && Object.hasOwn(opts, "allowRunningPartial") && opts.allowRunningPartial === true);
    const skipForStop = (dirId: string): void => {
      operation.add({ scope: "profiles", id: dirId, state: "skipped", required: true, code: "PROFILE_STOP_REQUIRED",
        message: "No profile data or metadata was applied. Stop the profile, wait for browser exit, then pull again; other sync sections may still apply.",
        runtimeEffect: { state: "running-or-unconfirmed", action: "skipped-stop-required", stopRequired: true, restartRequired: false, queuedCookies: 0, liveCookiesApplied: 0 } });
    };
    let historyConfigCommitted = false;
    try {
      const selectedHistory = historySelected(sync, opts);
      assertActiveHistoryScope(sync, selectedHistory);
      const appliedHistory = new Map<string, HistoryCoverage>();
      const fetched = await fetchSyncConfig(sync, signal);
      if (!fetched.ok) {
        finalResult = operation.failure(new Error(fetched.message));
        return finalResult;
      }

      const payload = fetched.payload;
      if (payload.artifactVersion === 4) throw fullProfileError("FULL_PROFILE_CONSENT_REQUIRED", "This snapshot contains complete encrypted browser data; enable complete migration and enter its passphrase before restoring");
      assertComparisonUnchanged(opts?.comparisonToken, sync, payload);
      const raw = gunzipBase64Field(payload.data, MAX_CONFIG_GZIP_BYTES, MAX_CONFIG_JSON_BYTES, "sync config");
      // Preserve original presence/absence of identity seed before the portable
      // projection supplies legacy defaults. An imported baseline is not live proof.
      const rawRemoteConfig = JSON.parse(raw.toString()) as any;
      const rawRemoteProfiles = rawRemoteConfig.browserProfiles ?? rawRemoteConfig.cloakProfiles ?? {};
      const remoteConfig = sanitizeRemoteConfig(rawRemoteConfig as MgmtConfig);
      assertSyncNotAborted(signal);

      const pullTimestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();
      const importedPreferenceIds = new Set<string>();
      const importedPreferenceHashes: Record<string, string> = {};
      const allowedProfileIds = new Set(Object.keys(remoteConfig.browserProfiles || {}));
      if (allowedProfileIds.size > MAX_SYNC_PROFILES) throw new Error("Remote config contains too many profiles");
      validateArtifactProfileIds(payload, allowedProfileIds);
      const remoteHistory = parseRemoteHistory(payload, remoteConfig.browserProfiles || {});

      // Select artifacts from a frozen local snapshot BEFORE touching any
      // profile directory, cookies, or files. At commit, verify each selected
      // remote profile still matches that snapshot and merge into the live draft.
      // Equal metadata still has an artifact source: browser state may differ.
      // Clone because callers can mutate the current config object before save.
      const profileSnapshot = structuredClone(getConfig().browserProfiles || {});
      const mergeStrategy = normalizeMergeStrategy(opts?.strategy);
      const resolutions = opts?.resolutions;
      const profileResolve = (id: string): MergeStrategy | null => resolutionFor(resolutions, "profiles", id);
      const remoteProfiles = remoteConfig.browserProfiles || {};
      const selectedRemoteProfiles = selectRemoteEntries(profileDecisionMap(profileSnapshot), profileDecisionMap(remoteProfiles), mergeStrategy, profileResolve);
      if (!allowRunningPartial) {
        for (const dirId of selectedRemoteProfiles) {
          if (isProfileRunningForRestore(dirId)) {
            skipForStop(dirId);
            selectedRemoteProfiles.delete(dirId);
          }
        }
      }
      const selectedRemoteEntries = Object.fromEntries(
        [...selectedRemoteProfiles].map((id) => [id, remoteProfiles[id]]),
      );

      stageRoot = createPullStagingRoot();
      type PullArtifacts = { cookies?: CookieInfo[]; localStorage?: PreparedLocalStorage; preferences?: Buffer; history?: PreparedHistory; historyCoverage?: HistoryCoverage };
      const prepared = new Map<string, PullArtifacts>();
      let aggregateHistoryBytes = 0;
      let aggregateCookies = 0;
      let aggregateLocalStorageBytes = 0;
      let aggregatePreferenceBytes = 0;
      let archiveCount = 0;
      // Prepare every selected artifact before the first profile/queue write.
      for (const dirId of selectedRemoteProfiles) {
        assertSyncNotAborted(signal);
        assertSelectedProfileUnchanged(profileSnapshot, getConfig().browserProfiles || {}, dirId);
        assertProfilePathsSafe(dirId);
        assertLocalStorageRestorable(dirId);
        const item: PullArtifacts = { historyCoverage: remoteHistory[dirId] };
        if (Object.hasOwn(payload.cookies || {}, dirId)) {
          item.cookies = parseCookieBlob(payload.cookies[dirId]);
          aggregateCookies += item.cookies.length;
          if (aggregateCookies > MAX_PULL_COOKIES) throw new Error("Remote config contains too many cookies");
        }
        if (Object.hasOwn(payload.preferences || {}, dirId)) {
          item.preferences = gunzipBase64Field(payload.preferences[dirId], MAX_PREFERENCES_GZIP_BYTES, MAX_PREFERENCES_JSON_BYTES, "preferences");
          validatePreferencesJson(item.preferences);
          aggregatePreferenceBytes += item.preferences.length;
          if (aggregatePreferenceBytes > MAX_PULL_PREFERENCES_BYTES) throw new Error("Remote config contains too much preferences data");
        }
        if (Object.hasOwn(payload.localStorage || {}, dirId)) {
          if (++archiveCount > MAX_PULL_LOCAL_STORAGE_ARCHIVES) throw new Error("Remote config contains too many localStorage archives");
          item.localStorage = await prepareLocalStorage(dirId, decodeBase64Field(payload.localStorage[dirId], MAX_LOCAL_STORAGE_TGZ_BYTES, "localStorage"), stageRoot, MAX_PULL_LOCAL_STORAGE_BYTES - aggregateLocalStorageBytes, signal);
          aggregateLocalStorageBytes += item.localStorage.bytesWritten;
        }
        const baseline = parseProfileSyncBaseline(remoteProfiles[dirId]?.syncBaseline);
        if ([2, 3].includes(payload.artifactVersion) && (!baseline || baseline.snapshotId !== payload.snapshotId)) throw new Error("Remote profile baseline is missing or belongs to another snapshot");
        if (baseline) {
          const evidence = profilePreferencesSnapshot(item.preferences ?? null);
          if (stableStringify(baseline.preferences) !== stableStringify(evidence) ||
              profileContentHash(remoteProfiles[dirId], evidence) !== baseline.contentHash) throw new Error("Remote profile content does not match its published baseline");
        }
        if (selectedHistory && item.historyCoverage?.artifact) {
          const artifact = item.historyCoverage.artifact;
          if (profileSnapshot[dirId] && historyEngine(profileSnapshot[dirId]) !== artifact.engine) throw new Error("Incompatible target history engine; original profile retained");
          aggregateHistoryBytes += artifact.members.reduce((n, member) => n + member.bytes, 0);
          if (aggregateHistoryBytes > MAX_SYNC_HISTORY_BYTES) throw new Error("Aggregate history byte limit exceeded");
          assertSyncRole("pull"); assertActiveHistoryScope(sync, true);
          const body = await s3Get(sync, artifact.object.key, signal, MAX_HISTORY_OBJECT_BYTES);
          assertSyncRole("pull"); assertActiveHistoryScope(sync, true);
          if (!body) throw new Error(`History object unavailable: ${dirId}`);
          item.history = await prepareHistoryArtifact(body, artifact, stageRoot, signal);
          assertSyncRole("pull"); assertActiveHistoryScope(sync, true);
          assertSelectedProfileUnchanged(profileSnapshot, getConfig().browserProfiles || {}, dirId);
          // Before any profile writes, reject replacing another engine/schema.
          // Runtime-unconfirmed profiles are skipped at apply without source reads.
          if (!isProfileRunningForRestore(dirId)) {
            const release = acquireRestoreLock(dirId);
            try {
              assertHistoryRestorable(dirId, artifact.engine);
              const guard = () => { assertSyncRole("pull"); assertActiveHistoryScope(sync, true); assertHistoryStopped(dirId); assertSelectedProfileUnchanged(profileSnapshot, getConfig().browserProfiles || {}, dirId); };
              const existing = await captureHistory(resolveProfileDir(dirId), artifact.engine, stageRoot, guard, signal);
              if (existing && stableStringify(existing.summary.schema) !== stableStringify(artifact.schema)) throw new Error("Incompatible target history schema/version; original group retained");
            } finally { release(); }
          }
        }
        prepared.set(dirId, item);
      }
      const preparedExtensions = await preparePullExtensions(sync, remoteConfig, stageRoot, signal, [2, 3].includes(payload.artifactVersion));
      assertSyncNotAborted(signal);
      let importedCookies = 0;
      let queuedCookies = 0;
      let importedLs = 0;
      let importedPrefs = 0;
      lease.stage("applying");
      for (const [dirId, artifacts] of prepared) {
        assertSyncRole("pull");
        assertSelectedProfileUnchanged(profileSnapshot, getConfig().browserProfiles || {}, dirId);
        const release = acquireRestoreLock(dirId);
        let keepLock = false;
        let pendingRuntimeImport: Promise<number> | undefined;
        try {
          assertSyncNotAborted(signal);
          const running = isProfileRunningForRestore(dirId);
          if (running && !allowRunningPartial) {
            skipForStop(dirId);
            selectedRemoteProfiles.delete(dirId);
            delete selectedRemoteEntries[dirId];
            continue;
          }
          assertLocalStorageRestorable(dirId);
          const runtimeEffect: SyncProfileRuntimeEffect = {
            state: running ? "running-or-unconfirmed" : "stopped", action: running ? "running-partial" : "restored-stopped",
            stopRequired: running, restartRequired: running, queuedCookies: 0, liveCookiesApplied: 0,
          };
          const receipt: SyncItemResult = { scope: "profiles", id: dirId, state: "preserved", required: false,
            code: "PROFILE_RESTORE_PENDING", message: "Profile configuration has not yet been adopted.", runtimeEffect };
          profileReceipts.set(dirId, receipt);
          operation.add(receipt);
          // Keep admitted launches excluded through metadata adoption, not just
          // through each artifact write. Reads/preparation/skips never mark data.
          profileLocks.set(dirId, release);
          keepLock = true;
          markProfileDataChanging(dirId);
          if (!allowRunningPartial) assertHistoryStopped(dirId);
          if (!fs.existsSync(resolveProfileDir(dirId))) {
            fs.mkdirSync(resolveProfileDir(dirId), { mode: 0o700 });
            createdProfileIds.add(dirId);
          }
          ensureProfileDefaultDir(dirId);
          const coverage = artifacts.historyCoverage;
          if (!selectedHistory || !coverage || !artifacts.history && coverage.state !== "absent") {
            operation.add({ scope: "history", id: dirId, state: "skipped", required: selectedHistory && Boolean(coverage),
              code: !selectedHistory ? "HISTORY_NOT_SELECTED" : !coverage ? "HISTORY_LEGACY_UNCOVERED" : coverage.code || "HISTORY_NOT_COVERED", history: coverage });
          } else {
            const guard = () => { assertSyncRole("pull"); assertActiveHistoryScope(sync, true); assertSelectedProfileUnchanged(profileSnapshot, getConfig().browserProfiles || {}, dirId); assertHistoryStopped(dirId); };
            try { guard(); }
            catch (error) {
              if (["HISTORY_SCOPE_CHANGED", "TEAM_ROLE_DENIED"].includes((error as any)?.code)) throw error;
              operation.add({ scope: "history", id: dirId, state: "skipped", required: true, code: "PROFILE_RUNNING_OR_UNCONFIRMED", history: coverage });
              operation.warnings.push(`History for ${dirId} was not applied: ${(error as Error).message}`);
            }
            if (!operation.items.some((item) => item.scope === "history" && item.id === dirId && item.code === "PROFILE_RUNNING_OR_UNCONFIRMED")) {
              assertHistoryRestorable(dirId, coverage.engine);
              const existing = await captureHistory(resolveProfileDir(dirId), coverage.engine, stageRoot, guard, signal);
              guard();
              if (artifacts.history) {
                if (existing && stableStringify(existing.summary.schema) !== stableStringify(artifacts.history.summary.schema)) throw new Error("Incompatible target history schema/version; original group retained");
                const restored = importSqliteLocalStorage(dirId, artifacts.history, operation.operationId, signal, { engine: coverage.engine, guard });
                if (restored.rollback) historyRollbacks.push(() => restored.rollback!());
                operation.add({ scope: "history", id: dirId, state: "applied", bytes: restored.bytesWritten, history: coverage });
                appliedHistory.set(dirId, coverage);
                if (restored.backupDir) operation.warnings.push(`Previous History/Places group retained for runtime validation: ${restored.backupDir}`);
              } else {
                // Confirmed absence is not an empty database and never deletes
                // the receiver's existing history/bookmarks.
                operation.add({ scope: "history", id: dirId, state: "preserved", required: false, code: "HISTORY_SOURCE_ABSENT", history: coverage });
                if (!existing) appliedHistory.set(dirId, coverage);
              }
            }
          }
          if (artifacts.cookies) {
            const list = artifacts.cookies;
            if (!list.length) {
              operation.add({ scope: "cookies", id: dirId, state: "preserved", count: 0, code: "EMPTY_COOKIE_SNAPSHOT", message: "Empty snapshot; merge import does not delete existing cookies" });
            } else if (runtimeCookieOps.hasRunningBrowser(dirId)) {
              if (!allowRunningPartial) assertProfileTransferStopped(dirId, () => statusBrowser(dirId), () => runtimeCookieOps.hasRunningBrowser(dirId), { engine: getConfig().browserProfiles?.[dirId]?.engine });
              const previousCommit = operation.localCommit;
              operation.localCommit = "unknown";
              runtimeEffect.liveCookiesUnconfirmed = true;
              pendingRuntimeImport = runtimeCookieOps.importCookies(dirId, list, combineAbortSignals(signal, 30000));
              const n = await withTimeout(pendingRuntimeImport, 30000, signal);
              if (n === null || !Number.isInteger(n) || n < 0 || n > list.length) {
                operation.add({ scope: "cookies", id: dirId, state: "unknown", code: "COOKIE_IMPORT_UNCONFIRMED" });
                throw Object.assign(new Error("Runtime Cookie import result is unknown; do not retry automatically"), { code: "COOKIE_IMPORT_UNCONFIRMED" });
              }
              operation.localCommit = previousCommit;
              runtimeEffect.liveCookiesUnconfirmed = false;
              operation.add({ scope: "cookies", id: dirId, state: "applied", count: n });
              runtimeEffect.liveCookiesApplied += n;
              importedCookies += n;
              if (n !== list.length) {
                operation.add({ scope: "cookies", id: dirId, state: "failed", code: "COOKIE_IMPORT_INCOMPLETE" });
                throw new Error("Runtime Cookie import was incomplete");
              }
              assertSyncNotAborted(signal);
            } else {
              try {
                if (!allowRunningPartial) assertHistoryStopped(dirId);
                writeQueuedCookieImports(dirId, list);
                if (operation.localCommit === "none") operation.localCommit = "partial";
                if (JSON.stringify(readQueuedCookieImports(dirId)) !== JSON.stringify(list)) throw new Error("Cookie queue readback mismatch after publication");
                operation.add({ scope: "cookies", id: dirId, state: "queued", count: list.length });
                runtimeEffect.queuedCookies += list.length;
                queuedCookies += list.length;
              } catch (error) {
                operation.add({ scope: "cookies", id: dirId, state: "failed", message: (error as Error).message });
                throw error;
              }
            }
          }
          assertSyncRole("pull");
          assertSelectedProfileUnchanged(profileSnapshot, getConfig().browserProfiles || {}, dirId);
          if (artifacts.localStorage || artifacts.preferences) {
            const running = isProfileRunningForRestore(dirId);
            if (artifacts.localStorage) {
              if (running) {
                operation.add({ scope: "localStorage", id: dirId, state: "skipped", code: "PROFILE_RUNNING" });
              } else {
                try {
                  const restored = importLocalStorage(dirId, artifacts.localStorage, operation.operationId, signal);
                  operation.add({ scope: "localStorage", id: dirId, state: restored.imported ? "applied" : "skipped", bytes: restored.bytesWritten, code: restored.imported ? undefined : "EMPTY_LOCAL_STORAGE_ARCHIVE" });
                  if (restored.imported) importedLs++;
                  if (restored.backupDir) operation.warnings.push(`Previous LocalStorage copy retained for runtime validation: ${restored.backupDir}`);
                } catch (error) {
                  operation.add({ scope: "localStorage", id: dirId, state: "failed", message: (error as Error).message });
                  throw error;
                }
              }
            }
            if (artifacts.preferences) {
              if (running) {
                operation.add({ scope: "preferences", id: dirId, state: "skipped", code: "PROFILE_RUNNING" });
              } else {
                try {
                  assertSyncNotAborted(signal);
                  safeExistingParentInsideProfile(dirId, ["Default", "Preferences"]);
                  writeFileAtomic(resolveProfileFile(dirId, "Default", "Preferences"), artifacts.preferences);
                  operation.add({ scope: "preferences", id: dirId, state: "applied", bytes: artifacts.preferences.length });
                  importedPreferenceHashes[dirId] = artifacts.preferences.toString("base64");
                  importedPreferenceIds.add(dirId);
                  importedPrefs++;
                } catch (error) {
                  operation.add({ scope: "preferences", id: dirId, state: "failed", message: (error as Error).message });
                  throw error;
                }
              }
            }
          }
        } finally {
          if (pendingRuntimeImport) {
            // An abort/deadline is not proof that the runtime stopped writing.
            // Keep both the profile lock and shared operation owner until settle.
            const [settled] = await Promise.allSettled([pendingRuntimeImport]);
            if (settled.status === "rejected") operation.warnings.push(`Runtime Cookie request for ${dirId} ended with an error; consult the per-item result before retrying.`);
          }
          if (!keepLock) release();
        }
      }

      const proxyResolve = (id: string): MergeStrategy | null => resolutionFor(resolutions, "proxies", id);
      const accountResolve = (id: string): MergeStrategy | null =>
        resolutionFor(resolutions, "accounts", id.split("\u0000").join(" @ "));
      let adoptedProfiles = 0;
      let adoptedProxies = 0;
      let adoptedAccounts = 0;
      assertSyncNotAborted(signal);
      // Read the live config at commit, not before an awaited runtime import.
      // Only remote-selected profile entries are eligible for replacement;
      // unrelated profiles (including ones created during the await) survive.
      // A selected entry edited or deleted during the await fails closed.
      transact((draft: MgmtConfig) => {
        assertSyncRole("pull"); assertActiveHistoryScope(sync, selectedHistory);
        const localProfiles = draft.browserProfiles || {};
        for (const dirId of selectedRemoteProfiles) {
          assertSelectedProfileUnchanged(profileSnapshot, localProfiles, dirId);
          if (!allowRunningPartial) assertHistoryStopped(dirId);
        }
        const mergedProfiles = mergeSectionById(localProfiles, selectedRemoteEntries, "remote", undefined, {
          ignoredFields: new Set([...SYNC_BOOKKEEPING_FIELDS, "fontsDir"]),
          onRemoteWin: (local, remote) => ({ ...local, ...remote, fontsDir: local.fontsDir ?? null }),
        });
        const mergedProxies = mergeProxySection(draft.proxies || {}, remoteConfig.proxies || {}, mergeStrategy, proxyResolve);
        const mergedAccounts = mergeAccountSection((remoteConfig as any).accounts, (draft as any).accounts, mergeStrategy, accountResolve);
        adoptedProfiles = countAdoptedFromRemote(localProfiles, mergedProfiles, mergeStrategy, profileResolve);
        adoptedProxies = countAdoptedFromRemote(draft.proxies || {}, mergedProxies, mergeStrategy, proxyResolve);
        adoptedAccounts = countAdoptedFromRemote(accountMapOf((draft as any).accounts), accountMapOf(mergedAccounts), mergeStrategy, accountResolve);
        draft.defaultProxy = remoteConfig.defaultProxy || draft.defaultProxy;
        draft.proxies = mergedProxies;
        (draft as any).accounts = mergedAccounts;
        draft.browserProfiles = mergedProfiles;
        (draft as any).team = mergeTeam((draft as any).team, (remoteConfig as any).team);
        markRemoteProfilesSynced(draft, remoteConfig, pullTimestamp, {
          selectedRemoteProfiles,
          preferences: importedPreferenceIds,
          preferenceHashes: importedPreferenceHashes,
          targetId: getProfileSyncTarget(sync),
        });
        for (const dirId of selectedRemoteProfiles) {
          const current = draft.browserProfiles[dirId], coverage = remoteHistory[dirId];
          const applied = appliedHistory.get(dirId);
          if (applied) {
            assertHistoryStopped(dirId);
            current.historySyncCoverage = applied;
            const baseline = historyBaseline(applied, getProfileSyncTarget(sync));
            if (baseline) current.historySyncBaseline = baseline;
          } else if (!selectedHistory) {
            current.historySyncCoverage = { version: 1, dirId, snapshotId: payload.snapshotId || operation.operationId, engine: historyEngine(current), state: "unselected", freshness: "not-covered", code: "HISTORY_NOT_SELECTED" };
          } else if (coverage) current.historySyncCoverage = coverage;
          else delete current.historySyncCoverage;
          if (current.historySyncBaseline && current.historySyncBaseline.engine !== historyEngine(current)) delete current.historySyncBaseline;
        }
      }, undefined, { forceAccountRevision: true, requireAccountRetention: true });

      historyConfigCommitted = true;
      operation.localCommit = "committed";
      operation.add({ scope: "config", state: "applied" });
      for (const dirId of selectedRemoteProfiles) {
        const identity = compareProfileIdentity(rawRemoteProfiles[dirId], getConfig().browserProfiles[dirId]);
        const receipt = profileReceipts.get(dirId)!;
        receipt.state = "applied";
        receipt.required = true;
        receipt.code = undefined;
        receipt.identity = identity;
        receipt.message = "Configuration identity comparison only; runtime fingerprint not re-verified. Start a fresh browser after any required stop and verify restored data.";
        if (identity.configuration.state === "missing-seed") operation.warnings.push(`Profile ${dirId} came from a legacy snapshot without a seed; configuration identity cannot be proven retained. Runtime fingerprint remains unverified.`);
      }
      let importedExts = 0;
      for (const extension of preparedExtensions) {
        assertSyncNotAborted(signal);
        try {
          const restored = await restoreSyncedExtensionPackage(extension.id, extension.packagePath, extension.remoteEntry, signal);
          operation.add({ scope: "extensions", id: extension.id, state: "applied" });
          for (const warning of restored.repositoryCommit?.cleanupWarnings || []) operation.warnings.push(warning.message);
          importedExts++;
          assertSyncNotAborted(signal);
        } catch (error) {
          operation.add({ scope: "extensions", id: extension.id, state: "failed", message: (error as Error).message });
          throw error;
        }
      }

      const parts: string[] = [];
      if (importedCookies > 0) parts.push(`${importedCookies} cookies imported`);
      if (queuedCookies > 0) parts.push(`${queuedCookies} cookies queued (not yet imported)`);
      if (importedLs > 0) parts.push(`${importedLs} localStorage`);
      if (importedPrefs > 0) parts.push(`${importedPrefs} preferences`);
      if (importedExts > 0) parts.push(`${importedExts} extensions`);
      const adopted: string[] = [];
      if (adoptedProfiles > 0) adopted.push(`${adoptedProfiles} profiles`);
      if (adoptedProxies > 0) adopted.push(`${adoptedProxies} proxies`);
      if (adoptedAccounts > 0) adopted.push(`${adoptedAccounts} accounts`);
     if (adopted.length) parts.push(adopted.join(", ") + " merged (remote adopted)");

      finalResult = operation.complete(`Pulled from ${new Date(pullTimestamp).toISOString()}${parts.length ? " (" + parts.join(", ") + ")" : ""}`);
      return finalResult;
    } catch (e: any) {
      if (e?.code === "PROFILE_STOP_REQUIRED") {
        const affected = profileReceipts.get(e.dirId);
        if (affected?.runtimeEffect) {
          affected.runtimeEffect.state = "running-or-unconfirmed";
          affected.runtimeEffect.stopRequired = true;
          affected.runtimeEffect.restartRequired = true;
          affected.code = "PROFILE_STOP_REQUIRED";
          affected.message = "Runtime became active or unconfirmed during restore. Metadata was not adopted; inspect per-item effects, stop the profile and wait for exit before retrying.";
        }
      }
      for (const receipt of profileReceipts.values()) {
        if (receipt.code === "PROFILE_RESTORE_PENDING") {
          receipt.code = "PROFILE_RESTORE_INCOMPLETE";
          receipt.message = "Profile configuration was not adopted; some data writes may already have occurred. Review per-item results before retrying.";
        }
      }
      if (!historyConfigCommitted && historyRollbacks.length) {
        let recoveryError: unknown;
        for (const rollback of historyRollbacks.reverse()) {
          try { rollback(); }
          catch (error) { recoveryError ??= error; operation.warnings.push(`History rollback was not confirmed: ${(error as Error).message}`); }
        }
        if (recoveryError) e = recoveryError;
        else {
          for (const item of operation.items) if (item.scope === "history" && item.state === "applied") { item.state = "preserved"; item.code = "HISTORY_ROLLED_BACK"; }
          operation.localCommit = operation.items.some((item) => item.scope !== "history" && item.side !== "remote" && ["applied", "queued"].includes(item.state)) ? "partial" : "none";
        }
      }
      finalResult = operation.failure(e, signal?.aborted);
      if (signal?.aborted) { e.syncResult = finalResult; throw e; }
      return finalResult;
    } finally {
      for (const dirId of createdProfileIds) {
        if (getConfig().browserProfiles?.[dirId]) continue;
        try {
          assertProfilePathsSafe(dirId);
          const dir = resolveProfileDir(dirId);
          const defaultDir = resolveProfileFile(dirId, "Default");
          if (fs.existsSync(defaultDir) && !fs.readdirSync(defaultDir).length) fs.rmdirSync(defaultDir);
          if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
          else operation.warnings.push(`Uncommitted profile files retained for recovery: ${dirId}`);
        } catch (error) { operation.warnings.push(`Could not clean uncommitted profile ${dirId}: ${(error as Error).message}`); }
      }
      if (stageRoot) {
        try { fs.rmSync(stageRoot, { recursive: true, force: true }); }
        catch (error) { operation.warnings.push(`Could not clean owned sync staging directory: ${(error as Error).message}`); }
      }
      for (const release of [...profileLocks.values()].reverse()) release();
      if (finalResult) finalResult.warnings = [...operation.warnings];
      lease.finish(finalResult ?? operation.failure(new Error("Sync pull ended without a confirmed result")));
    }
  },

  async historyState(dirId: string, signal?: AbortSignal) {
    validateDirId(dirId); assertSyncNotAborted(signal);
    const profile = structuredClone(getConfig().browserProfiles?.[dirId]);
    const sync = getSyncConfig();
    if (!profile) throw new Error("Profile not found");
    const release = acquireRestoreLock(dirId);
    let root: string | undefined;
    try {
      root = createPullStagingRoot();
      const guard = () => { assertActiveHistoryScope(sync, true); assertSelectedProfileUnchanged({ [dirId]: profile }, getConfig().browserProfiles || {}, dirId); assertHistoryStopped(dirId); assertHistoryRestorable(dirId, historyEngine(profile)); };
      return await readProfileHistorySyncState(dirId, profile, root, guard, signal);
    } finally { try { if (root) fs.rmSync(root, { recursive: true }); } finally { release(); } }
  },

  getStatus() {
    const sync = getSyncConfig();
    return {
      enabled: sync.enabled || false,
      configured: !!(sync.endpoint && sync.bucket && sync.accessKey),
      endpoint: sync.endpoint || "",
      bucket: sync.bucket || "",
      accessKeyMasked: maskKey(sync.accessKey || ""),
      operation: getSyncOperationState(),
      // Sale-93: the UI shows whether custody consent was recorded (and when).
      custodyConsentAt: typeof (sync as any)?.custodyConsentAt === "number" ? (sync as any).custodyConsentAt : null,
      includeHistory: sync.includeHistory === true,
      includeFullProfile: sync.includeFullProfile === true,
      fullProfileConsentAt: Number.isSafeInteger(sync.fullProfileConsentAt) && sync.fullProfileConsentAt! > 0 ? sync.fullProfileConsentAt : null,
      fullProfilePassphraseSet: Boolean(sync.fullProfilePassphrase),
      history: Object.fromEntries(Object.entries(getConfig().browserProfiles || {}).map(([id, profile]) => [id, profileHistoryCoverage(profile)])),
      historyConsentAt: Number.isSafeInteger(sync.historyConsentAt) && sync.historyConsentAt! > 0 ? sync.historyConsentAt : null,
    };
  },
};

function fullProfileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function fullProfileProxyName(meta: MgmtConfig["browserProfiles"][string], defaultProxy: string): string | undefined {
  return meta.proxyMode === "none" ? undefined : meta.proxyMode === "named" ? meta.proxyName || undefined : defaultProxy || "default";
}
function assertFullProfileScope(sync: SyncConfig, history?: boolean, readPassphrase = false): string {
  const current = getSyncConfig();
  if (!sync.includeFullProfile || !Number.isSafeInteger(sync.fullProfileConsentAt) || sync.fullProfileConsentAt! <= 0 ||
      !Number.isSafeInteger(sync.historyConsentAt) || sync.historyConsentAt! <= 0 || !sync.includeHistory || history === false) {
    throw fullProfileError("FULL_PROFILE_CONSENT_REQUIRED", "Complete migration includes saved passwords, history and site storage; enable its separate scope and save first");
  }
  if (!current.enabled || !current.custodyConsentAt || current.custodyConsentAt !== sync.custodyConsentAt ||
      getProfileSyncTarget(current) !== getProfileSyncTarget(sync) || !current.includeFullProfile ||
      current.fullProfileConsentAt !== sync.fullProfileConsentAt || current.historyConsentAt !== sync.historyConsentAt ||
      current.fullProfilePassphrase !== sync.fullProfilePassphrase || current.accessKey !== sync.accessKey || current.secretKey !== sync.secretKey) {
    throw fullProfileError("FULL_PROFILE_SCOPE_CHANGED", "Complete migration settings changed during the operation");
  }
  if (!readPassphrase) return "";
  const passphrase = decryptSecretOr(sync.fullProfilePassphrase || "", "");
  if (typeof passphrase !== "string" || Buffer.byteLength(passphrase) < 12 || Buffer.byteLength(passphrase) > 1024) {
    throw fullProfileError("FULL_PROFILE_PASSPHRASE_REQUIRED", "Set the same migration passphrase on both machines before complete push or pull");
  }
  return passphrase;
}
function assertFullProfileCookieQueueEmpty(dirId: string): void {
  let pending: CookieInfo[];
  try { pending = readQueuedCookieImports(dirId, { strict: true }); }
  catch {
    throw Object.assign(fullProfileError("FULL_PROFILE_COOKIE_QUEUE_UNAVAILABLE", "Cannot verify pending Cookie imports. Resolve the existing import queue before complete migration; it has not been cleared or replaced"), { dirId });
  }
  if (pending.length) {
    throw Object.assign(fullProfileError("FULL_PROFILE_COOKIE_QUEUE_PENDING", "Complete migration requires pending Cookie imports to finish first. Start the profile normally, confirm the import, then stop it and wait for browser exit before retrying; the queue has been preserved"), { dirId });
  }
}
function fullProfileRecoveryFailure(cause: unknown, ticket: FullProfileRecoveryTicket): Error {
  const paths = (cause as { recoveryPaths?: unknown })?.recoveryPaths;
  return Object.assign(fullProfileError("FULL_PROFILE_RECOVERY_REQUIRED", "Complete migration needs manual recovery. Browser launch remains blocked until the retained profile data and configuration have been reconciled"), {
    cause, dirId: ticket.dirId, recoveryReceiptPath: ticket.receiptPath,
    recoveryPaths: [...new Set([ticket.receiptPath, ticket.profileDir, ticket.backupDir, ticket.stagingDir,
      ...(Array.isArray(paths) ? paths.filter((value): value is string => typeof value === "string") : [])])],
  });
}
function confirmFullProfileConfigCommitted(): void {
  // The shared store's optional fsync does not certify this two-resource commit.
  // Verify and flush the actual config before removing a durable recovery gate.
  const file = getConfigPath(), expected = Buffer.from(JSON.stringify(getConfig(), null, 2));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expected.length) throw new Error("Complete migration config readback is unconfirmed");
  const flushAccess = process.platform === "win32" ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  const fd = fs.openSync(file, flushAccess | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new Error("Complete migration config identity changed");
    const bytes = Buffer.alloc(expected.length + 1); let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!Number.isInteger(read) || read < 0 || read > bytes.length - count) throw new Error("Complete migration config readback failed");
      if (read === 0) break;
      count += read;
    }
    if (count !== expected.length || !bytes.subarray(0, count).equals(expected)) throw new Error("Complete migration config readback mismatch");
    fs.fsyncSync(fd);
    const after = fs.lstatSync(file), flushed = fs.fstatSync(fd);
    for (const current of [after, flushed]) {
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino ||
          current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new Error("Complete migration config changed during verification");
    }
  } finally { fs.closeSync(fd); }
  if (!syncArchiveDirectory(path.dirname(file))) throw new Error("Complete migration config directory durability is unconfirmed");
}
function cleanupFullProfileStage(root: string | undefined, owner: fs.Stats | undefined, operation: SyncOperationResult, retain: boolean): void {
  if (!root || !owner) return;
  if (retain) { operation.warnings.push(`Complete migration staging retained for recovery: ${root}`); return; }
  try {
    const current = fs.lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Staging ownership changed");
    fs.rmSync(root, { recursive: true });
  } catch { operation.warnings.push(`Complete migration staging cleanup was not confirmed: ${root}`); }
}

async function pushFullProfileSnapshot(sync: SyncConfig, force: boolean, signal?: AbortSignal, comparisonToken?: SyncComparisonToken, opts?: SyncHistoryOptions): Promise<SyncResult> {
  const lease = beginSyncOperation("push");
  if ("busy" in lease) return lease.busy;
  const operation = lease.operation, releases: Array<() => void> = [], sourceGuards: Array<() => void> = [];
  let root: string | undefined, owner: fs.Stats | undefined, result: SyncResult | undefined, retain = false;
  try {
    const passphrase = assertFullProfileScope(sync, opts?.history, true);
    const { captureFullProfileTransfer, fullProfileProxyHash } = await import("./sync/full-profile-transfer.js");
    assertSyncRole("push", force); assertSyncNotAborted(signal);
    const initial = cloneConfig(getConfig()), snapshot = sanitizeConfigForSync(initial), timestamp = Date.now();
    const ids = Object.keys(snapshot.browserProfiles || {});
    if (ids.length > MAX_SYNC_PROFILES) throw new Error("Too many profiles in complete snapshot");
    const previous = await fetchSyncConfig(sync, signal);
    if (!previous.ok && !previous.message.startsWith("HTTP 404")) throw new Error("Cannot verify the previous remote snapshot");
    assertComparisonUnchanged(comparisonToken, sync, previous.ok ? previous.payload : null);
    const locks = await collectRemoteLocksBlockingPush(sync, signal, previous);
    if (!force && locks.length) throw fullProfileError("PROFILE_LOCKED", "A selected profile is checked out by another machine");
    root = createPullStagingRoot(); owner = fs.lstatSync(root);
    const preferences: Record<string, ProfilePreferencesSnapshot> = {};
    const captured: Array<{ id: string; body: Buffer; descriptor: import("./sync/full-profile-artifact.js").FullProfileArtifact }> = [];
    let total = 0;
    for (const id of ids) {
      releases.push(acquireRestoreLock(id));
      const guard = () => {
        assertSyncRole("push", force); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
        assertSelectedProfileUnchanged(initial.browserProfiles, getConfig().browserProfiles || {}, id); assertHistoryStopped(id);
        assertFullProfileCookieQueueEmpty(id);
        if (initial.defaultProxy !== getConfig().defaultProxy) throw new Error("Default proxy changed during complete capture");
        const name = fullProfileProxyName(initial.browserProfiles[id], initial.defaultProxy);
        if (name && stableStringify(initial.proxies[name]) !== stableStringify(getConfig().proxies[name])) throw new Error("Linked proxy changed during complete capture");
      };
      guard(); sourceGuards.push(guard);
      preferences[id] = profilePreferencesSnapshot(capturePreferences(id));
      const meta = snapshot.browserProfiles[id], proxyName = fullProfileProxyName(meta, initial.defaultProxy);
      const proxy = proxyName ? initial.proxies[proxyName] : undefined;
      const item = await captureFullProfileTransfer({ profileDir: resolveProfileDir(id), stagingDir: root, dirId: id,
        engine: historyEngine(meta), snapshotId: operation.operationId, sourcePlatform: process.platform,
        browserVersion: typeof meta.browserVersion === "string" ? meta.browserVersion : undefined,
        passphrase, guard, signal, environment: { profileHash: profileContentHash(meta, profilePreferencesSnapshot(null)),
          ...(proxy && proxyName ? { proxy: { name: proxyName, publicHash: fullProfileProxyHash(proxy), username: decryptSecretOr(proxy.username || "", ""), password: decryptSecretOr(proxy.password || "", "") } } : {}) } });
      guard(); total += item.body.length;
      if (total > 1024 * 1024 * 1024) throw fullProfileError("FULL_PROFILE_SIZE_LIMIT", "Complete snapshot exceeds its aggregate byte limit; no partial browser snapshot was published");
      captured.push({ id, body: item.body, descriptor: item.descriptor });
      operation.add({ side: "remote", scope: "credentials", id, state: "preserved", required: false,
        count: item.credentials.databases.reduce((sum, db) => sum + db.fields, 0), code: "SOURCE_CREDENTIALS_VERIFIED" });
    }
    const extensions: FrozenExtensionSnapshot[] = [];
    for (const entry of Object.values(initial.extensionRepository || {})) {
      assertSyncRole("push", force); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
      if (extensions.length >= MAX_SYNC_EXTENSIONS) throw new Error("Too many extension packages");
      const capture = (await import("./extension-repository.js")).captureRepositoryExtensionForSync;
      const frozen = await capture(entry, path.join(root, `complete-extension-${randomUUID()}`), signal);
      total += fs.statSync(frozen.packagePath).size;
      if (total > 1024 * 1024 * 1024) throw new Error("Complete snapshot byte limit exceeded");
      snapshot.extensionRepository![entry.id] = sanitizeExtensionRepoEntry(entry.id, frozen.entry); extensions.push(frozen);
    }
    markAllProfilesSynced(snapshot, timestamp, { profilePreferences: preferences, targetId: getProfileSyncTarget(sync), snapshotId: operation.operationId });
    const configBytes = Buffer.from(JSON.stringify(snapshot)), compressed = zlib.gzipSync(configBytes);
    if (configBytes.length > MAX_CONFIG_JSON_BYTES || compressed.length > MAX_CONFIG_GZIP_BYTES) throw new Error("Complete configuration exceeds its byte limit");
    const document = { version: snapshot.version, artifactVersion: 4, snapshotId: operation.operationId, timestamp,
      data: compressed.toString("base64"), fullProfiles: Object.fromEntries(captured.map(item => [item.id, item.descriptor])) };
    const body = Buffer.from(JSON.stringify(document));
    lease.stage("publishing");
    const publishVerified = async (key: string, bytes: Buffer, scope: "fullProfile" | "extensions", id: string): Promise<void> => {
      assertSyncRole("push", force); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
      const publication = await publishS3Object(sync, key, bytes, signal);
      operation.remoteCommit = publication.state === "accepted" ? "partial" : "unknown";
      const readback = publication.state === "rejected" ? null : await s3Get(sync, key, signal, bytes.length);
      assertSyncRole("push", force); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
      if (!readback?.equals(bytes)) throw fullProfileError("FULL_PROFILE_UPLOAD_UNCONFIRMED", "Complete migration object upload/readback was not confirmed; previous snapshot retained");
      for (const guard of sourceGuards) guard();
      operation.add({ side: "remote", scope, id, state: "uploaded", bytes: bytes.length });
    };
    for (const item of captured) await publishVerified(item.descriptor.key, item.body, "fullProfile", item.id);
    for (const extension of extensions) await publishVerified(extensionObjectKey(extension.entry), fs.readFileSync(extension.packagePath), "extensions", extension.entry.id);
    assertComparisonUnchanged(comparisonToken, sync, previous.ok ? previous.payload : null);
    for (const guard of sourceGuards) guard();
    assertSyncRole("push", force); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
    await publishS3Object(sync, SYNC_CONFIG_KEY, body, signal); operation.remoteCommit = "unknown";
    const observed = await fetchSyncConfig(sync, signal);
    if (!observed.ok || stableStringify(observed.payload) !== stableStringify(document)) throw fullProfileError("REMOTE_COMMIT_UNCONFIRMED", "Complete snapshot publication could not be verified");
    operation.remoteCommit = "committed"; operation.add({ side: "remote", scope: "config", state: "uploaded", bytes: body.length });
    transact((draft: MgmtConfig) => {
      assertSyncRole("push", force); assertFullProfileScope(sync, opts?.history);
      for (const guard of sourceGuards) guard();
      for (const id of ids) {
        assertSelectedProfileUnchanged(initial.browserProfiles, draft.browserProfiles || {}, id);
        const current = draft.browserProfiles[id], published = snapshot.browserProfiles[id];
        current.syncedAt = published.syncedAt; current.syncedHash = published.syncedHash; current.syncBaseline = published.syncBaseline;
      }
    });
    operation.localCommit = "committed"; operation.add({ scope: "baseline", state: "applied" });
    result = operation.complete(`Complete encrypted browser snapshot published for ${ids.length} profile(s). Includes saved-password databases, cookies, site storage and sessions; hardware-bound authenticators and website acceptance are not a migration guarantee.`, total + body.length);
    return result;
  } catch (error: any) {
    retain = error?.code === "FULL_PROFILE_RECOVERY_REQUIRED";
    result = operation.failure(error, signal?.aborted);
    if (signal?.aborted) { error.syncResult = result; throw error; }
    return result;
  } finally {
    cleanupFullProfileStage(root, owner, operation, retain);
    for (const release of releases.reverse()) release();
    if (result) result.warnings = [...operation.warnings];
    lease.finish(result ?? operation.failure(new Error("Complete push did not confirm its result")));
  }
}

async function pullFullProfileSnapshot(sync: SyncConfig, signal?: AbortSignal, opts?: SyncPullOptions): Promise<SyncResult> {
  const lease = beginSyncOperation("pull");
  if ("busy" in lease) return lease.busy;
  const operation = lease.operation, releases: Array<() => void> = [];
  const restored: Array<{ value: import("./sync/full-profile-artifact.js").RestoredFullProfile; ticket: FullProfileRecoveryTicket }> = [];
  const pendingRecovery = new Set<FullProfileRecoveryTicket>();
  let root: string | undefined, owner: fs.Stats | undefined, result: SyncResult | undefined, committed = false, retain = false;
  let configBeforeCommit: MgmtConfig | undefined;
  try {
    const passphrase = assertFullProfileScope(sync, opts?.history, true);
    if (opts?.allowRunningPartial) throw fullProfileError("FULL_PROFILE_STOP_REQUIRED", "Complete migration cannot be partially applied to a running profile");
    const { parseFullProfileArtifact, restorePreparedFullProfile } = await import("./sync/full-profile-artifact.js");
    const { prepareFullProfileTransfer, fullProfileProxyHash } = await import("./sync/full-profile-transfer.js");
    const fetched = await fetchSyncConfig(sync, signal);
    if (!fetched.ok) throw new Error(fetched.message);
    const payload = fetched.payload;
    if (payload.artifactVersion !== 4) throw fullProfileError("FULL_PROFILE_SNAPSHOT_REQUIRED", "The remote snapshot has no complete browser backup. Push a complete snapshot from the original machine first; nothing was restored");
    assertComparisonUnchanged(opts?.comparisonToken, sync, payload);
    const rawRemote = JSON.parse(gunzipBase64Field(payload.data, MAX_CONFIG_GZIP_BYTES, MAX_CONFIG_JSON_BYTES, "complete sync config").toString());
    const remote = sanitizeRemoteConfig(rawRemote as MgmtConfig), initial = cloneConfig(getConfig());
    const ids = Object.keys(remote.browserProfiles || {});
    validateArtifactProfileIds(payload, new Set(ids));
    if (ids.length > MAX_SYNC_PROFILES || !payload.fullProfiles || Object.keys(payload.fullProfiles).length !== ids.length) throw new Error("Complete profile inventory does not match its configuration");
    const descriptors = new Map<string, NonNullable<ReturnType<typeof parseFullProfileArtifact>>>();
    for (const id of ids) {
      const descriptor = parseFullProfileArtifact(payload.fullProfiles[id]);
      if (!descriptor || descriptor.dirId !== id || descriptor.engine !== historyEngine(remote.browserProfiles[id]) || descriptor.snapshotId !== payload.snapshotId) throw new Error("Complete profile descriptor identity mismatch");
      descriptors.set(id, descriptor);
    }
    const strategy = opts?.strategy === undefined ? "remote" : normalizeMergeStrategy(opts.strategy), resolve = (scope: string, id: string) => resolutionFor(opts?.resolutions, scope, id);
    const selected = selectRemoteEntries(profileDecisionMap(initial.browserProfiles), profileDecisionMap(remote.browserProfiles), strategy, id => resolve("profiles", id));
    if (ids.length && !selected.size) throw fullProfileError("FULL_PROFILE_SELECTION_REQUIRED", "No complete remote profile was selected. Choose remote restore; local-priority is not a completed migration");
    for (const id of ids) if (!selected.has(id)) operation.add({ scope: "fullProfile", id, state: "skipped", code: "FULL_PROFILE_LOCAL_PRESERVED", message: "The local decision preserved this profile; it was not migrated" });
    for (const id of selected) {
      releases.push(acquireRestoreLock(id));
      assertHistoryStopped(id); assertFullProfileCookieQueueEmpty(id);
      if (initial.browserProfiles[id] && historyEngine(initial.browserProfiles[id]) !== historyEngine(remote.browserProfiles[id])) throw fullProfileError("FULL_PROFILE_ENGINE_MISMATCH", "Complete migration does not convert between browser engines");
    }
    root = createPullStagingRoot(); owner = fs.lstatSync(root);
    const prepared: Array<{ id: string; value: Awaited<ReturnType<typeof prepareFullProfileTransfer>> }> = [];
    const credentialProxyNames = new Set<string>();
    let total = 0;
    const guardFor = (id: string) => () => {
      assertSyncRole("pull"); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
      assertSelectedProfileUnchanged(initial.browserProfiles, getConfig().browserProfiles || {}, id); assertHistoryStopped(id);
      assertFullProfileCookieQueueEmpty(id);
    };
    for (const id of selected) {
      const descriptor = descriptors.get(id)!, guard = guardFor(id); guard();
      total += descriptor.size;
      if (total > 1024 * 1024 * 1024) throw new Error("Complete migration aggregate byte limit exceeded");
      const body = await s3Get(sync, descriptor.key, signal, descriptor.size);
      if (!body) throw fullProfileError("FULL_PROFILE_OBJECT_UNAVAILABLE", "Complete browser data object is unavailable; nothing was restored");
      guard();
      const value = await prepareFullProfileTransfer({ body, descriptor, stagingDir: root, passphrase,
        dirId: id, engine: descriptor.engine, snapshotId: payload.snapshotId, receiverPlatform: process.platform,
        profileHash: profileContentHash(remote.browserProfiles[id], profilePreferencesSnapshot(null)), guard, signal });
      guard();
      const proxy = value.environment.proxy;
      if (proxy) {
        const remoteProxy = remote.proxies[proxy.name];
        if (fullProfileProxyName(remote.browserProfiles[id], remote.defaultProxy) !== proxy.name || !Object.hasOwn(remote.proxies, proxy.name) || !remoteProxy || fullProfileProxyHash(remoteProxy) !== proxy.publicHash) throw fullProfileError("FULL_PROFILE_PROXY_MISMATCH", "Linked proxy settings do not match their encrypted credentials");
        const { encryptLiteralSecret } = await import("./secrets.js");
        remote.proxies[proxy.name] = { ...remoteProxy, username: encryptLiteralSecret(proxy.username), password: encryptLiteralSecret(proxy.password) };
        credentialProxyNames.add(proxy.name);
      }
      prepared.push({ id, value });
    }
    const extensions = await preparePullExtensions(sync, remote, root, signal, true);
    assertSyncRole("pull"); assertFullProfileScope(sync, opts?.history); assertSyncNotAborted(signal);
    for (const extension of extensions) {
      const applied = await restoreSyncedExtensionPackage(extension.id, extension.packagePath, extension.remoteEntry, signal);
      operation.add({ scope: "extensions", id: extension.id, state: "applied" });
      for (const warning of applied.repositoryCommit?.cleanupWarnings || []) operation.warnings.push(warning.message);
    }
    lease.stage("applying");
    confirmFullProfileConfigCommitted();
    const preferenceHashes: Record<string, string> = {}, preferenceIds = new Set<string>();
    for (const item of prepared) {
      const guard = guardFor(item.id); guard();
      const ticket = beginFullProfileRecovery({ dirId: item.id, operationId: operation.operationId, stagingDir: root });
      pendingRecovery.add(ticket);
      markProfileDataChanging(item.id);
      let applied: import("./sync/full-profile-artifact.js").RestoredFullProfile;
      try { applied = restorePreparedFullProfile({ prepared: item.value.prepared, profileDir: resolveProfileDir(item.id), backupSuffix: ".full-profile-backup-" + operation.operationId, guard }); }
      catch (error: any) { throw error?.code === "FULL_PROFILE_RECOVERY_REQUIRED" ? fullProfileRecoveryFailure(error, ticket) : error; }
      restored.push({ value: applied, ticket });
      operation.add({ scope: "fullProfile", id: item.id, state: "applied", bytes: applied.bytes,
        runtimeEffect: { state: "stopped", action: "restored-stopped", stopRequired: false, restartRequired: true, queuedCookies: 0, liveCookiesApplied: 0 } });
      operation.add({ scope: "credentials", id: item.id, state: "applied", count: item.value.credentials.databases.reduce((sum, db) => sum + db.fields, 0),
        code: item.value.credentials.passwordUsability === "requires-firefox-nss-unlock" ? "FIREFOX_NSS_UNLOCK_REQUIRED" : "CREDENTIAL_DATABASES_VERIFIED" });
      if (item.value.credentials.passwordUsability === "requires-firefox-nss-unlock") operation.warnings.push("Firefox login/key files are paired and restored; unlock the existing Primary Password normally. NSS runtime unlock has not been verified.");
      for (const warning of applied.warnings || []) operation.warnings.push(warning);
      if (applied.backupDir) operation.warnings.push(`Previous complete profile retained: ${applied.backupDir}`);
      const raw = capturePreferences(item.id);
      if (raw !== null) { preferenceIds.add(item.id); preferenceHashes[item.id] = raw.toString("base64"); }
    }
    configBeforeCommit = getConfig();
    transact((draft: MgmtConfig) => {
      assertSyncRole("pull"); assertFullProfileScope(sync, opts?.history);
      for (const id of selected) {
        assertSelectedProfileUnchanged(initial.browserProfiles, draft.browserProfiles || {}, id); assertHistoryStopped(id);
        assertFullProfileCookieQueueEmpty(id);
      }
      const selectedEntries = Object.fromEntries([...selected].map(id => [id, remote.browserProfiles[id]]));
      draft.browserProfiles = mergeSectionById(draft.browserProfiles || {}, selectedEntries, "remote", undefined,
        { ignoredFields: new Set([...SYNC_BOOKKEEPING_FIELDS, "fontsDir"]), onRemoteWin: (local, incoming) => ({ ...local, ...incoming, fontsDir: local.fontsDir ?? null }) });
      const previousProxies = draft.proxies || {};
      draft.proxies = mergeProxySection(previousProxies, remote.proxies || {}, strategy, id => resolve("proxies", id));
      for (const name of credentialProxyNames) {
        const incoming = remote.proxies[name], previous = previousProxies[name];
        if (!previous || remoteWins(previous, incoming, resolve("proxies", name) ?? strategy)) {
          draft.proxies[name] = { ...draft.proxies[name], username: incoming.username, password: incoming.password };
        }
      }
      draft.accounts = mergeAccountSection(remote.accounts || [], draft.accounts || [], strategy, id => resolve("accounts", id.split("\u0000").join(" @ ")));
      draft.defaultProxy = remote.defaultProxy || draft.defaultProxy;
      const team = mergeTeam(draft.team ?? null, remote.team ?? null);
      if (team) draft.team = team; else delete draft.team;
      markRemoteProfilesSynced(draft, remote, payload.timestamp, { selectedRemoteProfiles: selected, preferences: preferenceIds, preferenceHashes, targetId: getProfileSyncTarget(sync) });
    }, undefined, { forceAccountRevision: true, requireAccountRetention: true });
    committed = true; operation.localCommit = "committed"; operation.add({ scope: "config", state: "applied" });
    confirmFullProfileConfigCommitted();
    for (const id of selected) assertFullProfileCookieQueueEmpty(id);
    for (const ticket of pendingRecovery) { finishFullProfileRecovery(ticket); pendingRecovery.delete(ticket); }
    for (const id of selected) operation.add({ scope: "profiles", id, state: "applied", identity: compareProfileIdentity(rawRemote.browserProfiles[id], getConfig().browserProfiles[id]),
      message: "Complete persistent data and credential databases restored; website acceptance, hardware authenticators and live fingerprint remain separate checks." });
    result = operation.complete(`Restored ${selected.size} complete encrypted browser profile(s). Start the restored browser to verify site sessions; hardware-bound passkeys are not transferred.`, total);
    return result;
  } catch (error: any) {
    const firstTicket = [...pendingRecovery][0];
    if (!committed && configBeforeCommit && getConfig() !== configBeforeCommit && firstTicket) {
      operation.localCommit = "unknown";
      error = fullProfileRecoveryFailure(error, firstTicket);
    }
    if (!committed && error?.code !== "FULL_PROFILE_RECOVERY_REQUIRED") {
      if (firstTicket) {
        try { confirmFullProfileConfigCommitted(); }
        catch (failure) { error = fullProfileRecoveryFailure(failure, firstTicket); }
      }
      if (error?.code !== "FULL_PROFILE_RECOVERY_REQUIRED") {
        let rollbackFailure: unknown;
        for (const item of restored.reverse()) {
          try {
            item.value.rollback();
            finishFullProfileRecovery(item.ticket); pendingRecovery.delete(item.ticket);
            const staleWarning = operation.warnings.indexOf(`Previous complete profile retained: ${item.value.backupDir}`);
            if (staleWarning >= 0) operation.warnings.splice(staleWarning, 1);
            if (item.value.rollbackDir) operation.warnings.push(`Incoming complete profile retained after verified rollback: ${item.value.rollbackDir}`);
          } catch (failure) { rollbackFailure ??= fullProfileRecoveryFailure(failure, item.ticket); }
        }
        if (!rollbackFailure) {
          try { for (const ticket of pendingRecovery) { finishFullProfileRecovery(ticket); pendingRecovery.delete(ticket); } }
          catch (failure) { rollbackFailure = failure; }
        }
        if (rollbackFailure) { error = rollbackFailure; retain = true; }
        else {
          for (const item of operation.items) if (item.scope === "fullProfile" || item.scope === "credentials") { item.state = "preserved"; item.code = "FULL_PROFILE_ROLLED_BACK"; }
          operation.localCommit = operation.items.some(item => item.scope === "extensions" && item.state === "applied") ? "partial" : "none";
        }
      }
    }
    const pending = [...pendingRecovery];
    if (pending.length) {
      retain = true;
      const primary = pending.find(ticket => ticket.dirId === error?.dirId) ?? pending[0];
      error = fullProfileRecoveryFailure(error, primary);
      for (const ticket of pending) if (ticket !== primary) operation.recovery.push({ resource: "profiles", id: ticket.dirId,
        receiptPath: ticket.receiptPath, paths: [ticket.profileDir, ticket.backupDir, ticket.stagingDir] });
    }
    retain ||= error?.code === "FULL_PROFILE_RECOVERY_REQUIRED";
    result = operation.failure(error, signal?.aborted);
    if (signal?.aborted) { error.syncResult = result; throw error; }
    return result;
  } finally {
    cleanupFullProfileStage(root, owner, operation, retain);
    for (const release of releases.reverse()) release();
    if (result) result.warnings = [...operation.warnings];
    lease.finish(result ?? operation.failure(new Error("Complete pull did not confirm its result")));
  }
}

interface FrozenExtensionSnapshot {
  entry: ExtensionRepositoryEntry;
  packagePath: string;
  commitLocalRepair?: () => Promise<{ repositoryCommit: { committed: true; cleanupWarnings: Array<{ message: string }> } } | null>;
}

function extensionObjectKey(entry: { id: string; packageHash: string; source: string }, addressed = true): string {
  if (!/^(?:[a-p]{32}|local_[a-z0-9]{8,40})$/.test(entry.id) || !EXTENSION_HASH_RE.test(entry.packageHash)) throw new Error("Invalid extension package identity");
  return `extension-${entry.id}${addressed ? "-" + entry.packageHash.toLowerCase() : ""}.${entry.source === "chrome-web-store" ? "crx" : "zip"}`;
}

function capturePreferences(dirId: string, validate = true): Buffer | null {
  assertProfilePathsSafe(dirId);
  const file = resolveProfileFile(dirId, "Default", "Preferences");
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PREFERENCES_JSON_BYTES) throw new Error("Preferences is not a bounded regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.lstatSync(file);
    if (opened.dev !== before.dev || opened.ino !== before.ino || raw.length !== before.size || after.isSymbolicLink() ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Preferences changed during capture; retry after the profile has settled");
    }
    if (validate) validatePreferencesJson(raw);
    return raw;
  } finally { fs.closeSync(fd); }
}

export interface SyncHistoryOptions { history?: boolean; }
function historySelected(sync: SyncConfig, opts?: SyncHistoryOptions): boolean {
  if (opts?.history !== undefined && typeof opts.history !== "boolean") throw new Error("History scope must be a boolean");
  const selected = opts?.history ?? sync.includeHistory === true;
  if (selected && !(Number.isSafeInteger(sync.historyConsentAt) && sync.historyConsentAt! > 0)) {
    throw Object.assign(new Error("History scope consent required (includes Firefox Places bookmarks)"), { code: "HISTORY_CONSENT_REQUIRED" });
  }
  return selected;
}
function assertActiveHistoryScope(sync: SyncConfig, selected: boolean): void {
  if (!selected) return;
  const current = getSyncConfig();
  let sameTarget = false;
  try { sameTarget = getProfileSyncTarget(current) === getProfileSyncTarget(sync); }
  catch { sameTarget = false; }
  if (!sameTarget || !Number.isSafeInteger(current.historyConsentAt) || current.historyConsentAt! <= 0 || current.historyConsentAt !== sync.historyConsentAt) {
    throw Object.assign(new Error("History consent or storage target changed during this operation; no further history transfer is authorized"), { code: "HISTORY_SCOPE_CHANGED" });
  }
}
function assertHistoryStopped(dirId: string): void {
  assertProfilePathsSafe(dirId);
  assertProfileTransferStopped(dirId, () => statusBrowser(dirId), () => runtimeCookieOps.hasRunningBrowser(dirId), { engine: getConfig().browserProfiles?.[dirId]?.engine });
}
function historyEngine(profile: any): BrowserEngine {
  if (profile?.engine !== undefined && profile.engine !== "chromium" && profile.engine !== "firefox") throw new Error("Unsupported profile history engine");
  return profile?.engine || "chromium";
}

async function pushFrozenSnapshot(sync: SyncConfig, force: boolean, signal?: AbortSignal, comparisonToken?: SyncComparisonToken, opts?: SyncHistoryOptions): Promise<SyncResult> {
  const lease = beginSyncOperation("push");
  if ("busy" in lease) return lease.busy;
  const operation = lease.operation;
  let stageRoot: string | undefined;
  let result: SyncResult | undefined;
  let browserBackupIncomplete = false;
  try {
    const timestamp = Date.now();
    const initial = cloneConfig(getConfig());
    const snapshot = sanitizeConfigForSync(initial);
    const targetId = getProfileSyncTarget(sync);
    const ids = Object.keys(snapshot.browserProfiles || {});
    if (ids.length > MAX_SYNC_PROFILES) throw new Error("Too many profiles in sync snapshot");
    const fetched = await fetchSyncConfig(sync, signal);
    if (!fetched.ok && !fetched.message.startsWith("HTTP 404")) throw new Error(`Cannot verify the previous remote snapshot: ${fetched.message}`);
    const previous = fetched.ok ? fetched.payload : {};
    if (previous.artifactVersion === 4) throw fullProfileError("FULL_PROFILE_DOWNGRADE_BLOCKED", "The remote contains a complete browser backup; limited synchronization must not replace it. Enable complete migration first");
    assertComparisonUnchanged(comparisonToken, sync, fetched.ok ? fetched.payload : null);
    const locks = await collectRemoteLocksBlockingPush(sync, signal, fetched);
    if (!force && locks.length) throw new Error(`Push blocked: ${locks.length} profile(s) locked by another device (${locks.map((lock) => lock.id).slice(0, 8).join(", ")}). Release their locks or force push.`);
    stageRoot = createPullStagingRoot();
    const cookies: Record<string, string> = {};
    const localStorage: Record<string, string> = {};
    const preferences: Record<string, string> = {};
    const preferenceSnapshots: Record<string, ProfilePreferencesSnapshot> = {};
    const history: Record<string, HistoryCoverage> = {};
    const historyObjects: Array<{ id: string; body: Buffer; artifact: NonNullable<HistoryCoverage["artifact"]> }> = [];
    const uploadedHistoryItems = new Map<string, SyncItemResult>();
    const selectedHistory = historySelected(sync, opts);
    let historyBytes = 0;
    const artifactSources: Record<string, Record<string, string>> = { cookies: {}, localStorage: {}, preferences: {}, history: {} };
    const artifactCapturedAt: Record<string, Record<string, number | null>> = { cookies: {}, localStorage: {}, preferences: {} };
    const retainedCaptureTime = (scope: string, id: string): number | null => {
      const value = previous.artifactCapturedAt?.[scope]?.[id];
      return Number.isSafeInteger(value) && value > 0 && value <= timestamp ? value : null;
    };
    const extensionInventories: Record<string, ReturnType<typeof listExtensionsForSync>> = {};
    let cookieCount = 0;
    let preferenceBytes = 0;
    let localStorageBytes = 0;
    for (const id of ids) {
      assertSyncNotAborted(signal);
      const release = acquireRestoreLock(id);
      try {
        if (isProfileRunningForRestore(id)) browserBackupIncomplete = true;
        const raw = capturePreferences(id);
        preferenceSnapshots[id] = profilePreferencesSnapshot(raw);
        artifactCapturedAt.preferences[id] = raw === null ? null : Date.now();
        artifactSources.preferences[id] = raw === null ? "absent" : "captured";
        if (raw !== null) {
          preferenceBytes += raw.length;
          if (preferenceBytes > MAX_PULL_PREFERENCES_BYTES) throw new Error("Sync snapshot contains too much preferences data");
          const compressed = zlib.gzipSync(raw);
          if (compressed.length > MAX_PREFERENCES_GZIP_BYTES) throw new Error("Preferences compressed snapshot is too large");
          preferences[id] = compressed.toString("base64");
        }
        extensionInventories[id] = listExtensionsForSync(id);
        const cookieSnapshot = await runtimeCookieOps.exportCookiesSnapshot(id, signal);
        assertSyncNotAborted(signal);
        if (cookieSnapshot.state === "cancelled") throw new Error("Cookie export cancelled");
        if (cookieSnapshot.state === "available") {
          const list = cookieSnapshot.cookies.map(normalizeCookieForSync);
          if (list.length > MAX_COOKIE_COUNT) throw new Error("Too many cookies in sync snapshot");
          const rawCookies = Buffer.from(JSON.stringify(list));
          if (rawCookies.length > MAX_COOKIES_JSON_BYTES) throw new Error("Cookies JSON snapshot is too large");
          const compressed = zlib.gzipSync(rawCookies);
          if (compressed.length > MAX_COOKIES_GZIP_BYTES) throw new Error("Cookies compressed snapshot is too large");
          cookies[id] = compressed.toString("base64");
          artifactSources.cookies[id] = "captured";
          artifactCapturedAt.cookies[id] = Date.now();
        } else {
          browserBackupIncomplete = true;
          if (Object.hasOwn(previous.cookies || {}, id)) {
            parseCookieBlob(previous.cookies[id]);
            cookies[id] = previous.cookies[id];
          }
          artifactSources.cookies[id] = cookies[id] ? "preserved" : "unavailable";
          artifactCapturedAt.cookies[id] = cookies[id] ? retainedCaptureTime("cookies", id) : null;
          operation.add({ side: "remote", scope: "cookies", id, state: cookies[id] ? "preserved" : "skipped", required: false, code: "COOKIE_SOURCE_UNAVAILABLE" });
          operation.warnings.push(`Cookies for ${id} were not freshly verified (${cookieSnapshot.reason}); ${cookies[id] ? "previous remote data retained" : "no previous snapshot available"}.`);
        }
        if (cookies[id]) {
          cookieCount += parseCookieBlob(cookies[id]).length;
          if (cookieCount > MAX_PULL_COOKIES) throw new Error("Too many cookies in sync snapshot");
        }
        if (isProfileRunningForRestore(id)) {
          browserBackupIncomplete = true;
          if (Object.hasOwn(previous.localStorage || {}, id)) {
            const old = decodeBase64Field(previous.localStorage[id], MAX_LOCAL_STORAGE_TGZ_BYTES, "previous localStorage");
            const checked = fs.mkdtempSync(path.join(stageRoot, "ls-previous-"));
            localStorageBytes += (await validateLocalStorageArchive(old, checked, MAX_PULL_LOCAL_STORAGE_BYTES - localStorageBytes, signal)).bytesWritten;
            fs.rmSync(checked, { recursive: true });
            localStorage[id] = previous.localStorage[id];
          }
          artifactSources.localStorage[id] = localStorage[id] ? "preserved" : "unavailable";
          artifactCapturedAt.localStorage[id] = localStorage[id] ? retainedCaptureTime("localStorage", id) : null;
          operation.add({ side: "remote", scope: "localStorage", id, state: localStorage[id] ? "preserved" : "skipped", required: false, code: "PROFILE_RUNNING" });
          operation.warnings.push(`LocalStorage for running profile ${id} was not captured; ${localStorage[id] ? "previous remote copy retained" : "no database snapshot available"}.`);
        } else if (localStorageFormat(id) !== "absent") {
          const archive = await exportLocalStorage(id, stageRoot, signal);
          if (!archive) throw new Error(`Cannot capture LocalStorage for ${id}`);
          const checked = fs.mkdtempSync(path.join(stageRoot, "ls-captured-"));
          localStorageBytes += (await validateLocalStorageArchive(archive, checked, MAX_PULL_LOCAL_STORAGE_BYTES - localStorageBytes, signal)).bytesWritten;
          fs.rmSync(checked, { recursive: true });
          localStorage[id] = archive.toString("base64");
          artifactSources.localStorage[id] = "captured";
          artifactCapturedAt.localStorage[id] = Date.now();
        } else {
          artifactSources.localStorage[id] = "absent";
          artifactCapturedAt.localStorage[id] = null;
        }
        const engine = historyEngine(initial.browserProfiles[id]);
        const base = { version: 1 as const, snapshotId: operation.operationId, dirId: id, engine };
        let captureError: unknown;
        if (selectedHistory) {
          try {
            const guard = () => { assertSyncRole("push", force); assertActiveHistoryScope(sync, true); assertSelectedProfileUnchanged(initial.browserProfiles, getConfig().browserProfiles || {}, id); assertHistoryStopped(id); assertHistoryRestorable(id, engine); };
            const capturedAt = Date.now();
            const captured = await captureHistory(resolveProfileDir(id), engine, stageRoot, guard, signal, MAX_SYNC_HISTORY_BYTES - historyBytes);
            assertSyncNotAborted(signal);
            if (!captured) history[id] = { ...base, state: "absent", freshness: "captured", capturedAt };
            else {
              historyBytes += captured.bytesWritten;
              if (historyBytes > MAX_SYNC_HISTORY_BYTES) throw new Error("Aggregate history byte limit exceeded");
              const object = await makeHistoryArtifact(captured, engine, id, operation.operationId, capturedAt, stageRoot, signal);
              guard();
              history[id] = { ...base, state: Object.values(captured.summary.counts).every((n) => n === "0") ? "empty" : "complete", freshness: "captured", artifact: object.artifact };
              historyObjects.push({ id, ...object });
            }
          } catch (error) {
            assertSyncNotAborted(signal);
            if (["HISTORY_RECOVERY_REQUIRED", "HISTORY_SCOPE_CHANGED", "TEAM_ROLE_DENIED"].includes((error as any)?.code)) throw error;
            captureError = error;
          }
        }
        if (!history[id]) {
          const old = parseHistoryCoverage(previous.history?.[id]);
          if (old?.artifact && old.dirId === id && old.engine === engine) {
            if (selectedHistory) {
              assertSyncRole("push", force); assertActiveHistoryScope(sync, true);
              historyBytes += old.artifact.members.reduce((n, member) => n + member.bytes, 0);
              if (historyBytes > MAX_SYNC_HISTORY_BYTES) throw new Error("Aggregate history byte limit exceeded");
              const body = await s3Get(sync, old.artifact.object.key, signal, MAX_HISTORY_OBJECT_BYTES);
              assertSyncRole("push", force); assertActiveHistoryScope(sync, true);
              if (!body) throw new Error("Cannot verify the previous history object; previous remote envelope retained");
              await prepareHistoryArtifact(body, old.artifact, stageRoot, signal);
              assertSyncRole("push", force); assertActiveHistoryScope(sync, true);
            }
            // Excluding history retains only its prior reference, not a new
            // capture, download, freshness claim or locally adopted baseline.
            history[id] = { ...base, state: "preserved", freshness: "preserved", artifact: old.artifact, code: selectedHistory ? (captureError as any)?.code === "HISTORY_SCHEMA_UNSUPPORTED" ? "HISTORY_SCHEMA_UNSUPPORTED" : "HISTORY_CAPTURE_FAILED" : "HISTORY_NOT_SELECTED" };
          } else history[id] = { ...base, state: selectedHistory ? "failed" : "unselected", freshness: "not-covered", code: selectedHistory ? (captureError as any)?.code === "HISTORY_SCHEMA_UNSUPPORTED" ? "HISTORY_SCHEMA_UNSUPPORTED" : "HISTORY_CAPTURE_FAILED" : "HISTORY_NOT_SELECTED" };
        }
        const coverage = history[id]; artifactSources.history[id] = coverage.state;
        const incomplete = selectedHistory && (coverage.state === "failed" || coverage.state === "preserved");
        if (incomplete) browserBackupIncomplete = true;
        if (incomplete || coverage.state === "unselected" || coverage.state === "preserved") operation.add({ side: "remote", scope: "history", id,
          state: incomplete ? coverage.state === "preserved" ? "preserved" : "failed" : "skipped", required: selectedHistory, code: coverage.code, history: coverage });
        if (captureError) operation.warnings.push(`History for ${id} was not freshly captured: ${(captureError as Error).message}; ${coverage.state === "preserved" ? "previous verified object preserved" : "no verified history snapshot available"}.`);
      } finally { release(); }
    }
    const extensions: FrozenExtensionSnapshot[] = [];
    const entries = Object.values(initial.extensionRepository || {});
    if (entries.length > MAX_SYNC_EXTENSIONS) throw new Error("Too many extensions in sync snapshot");
    let packageBytes = 0;
    for (const entry of entries) {
      assertSyncNotAborted(signal);
      const capture = (await import("./extension-repository.js")).captureRepositoryExtensionForSync;
      const frozen = await capture(entry, path.join(stageRoot, `extension-snapshot-${randomUUID()}`), signal);
      const size = fs.statSync(frozen.packagePath).size;
      packageBytes += size;
      if (size > MAX_EXTENSION_PACKAGE_BYTES || packageBytes > MAX_PULL_EXTENSION_BYTES) throw new Error("Extension snapshot byte budget exceeded");
      snapshot.extensionRepository![entry.id] = sanitizeExtensionRepoEntry(entry.id, frozen.entry);
      extensions.push(frozen);
    }
    markAllProfilesSynced(snapshot, timestamp, { profilePreferences: preferenceSnapshots, targetId, snapshotId: operation.operationId });
    const configData = Buffer.from(JSON.stringify(snapshot));
    const configGzip = zlib.gzipSync(configData);
    if (configData.length > MAX_CONFIG_JSON_BYTES || configGzip.length > MAX_CONFIG_GZIP_BYTES) throw new Error("Sync configuration snapshot is too large");
    const document = { version: snapshot.version, artifactVersion: 3, snapshotId: operation.operationId, timestamp,
      data: configGzip.toString("base64"), cookies, localStorage, preferences, history, artifactSources, artifactCapturedAt };
    const body = Buffer.from(JSON.stringify(document));
    if (body.length > MAX_REMOTE_PAYLOAD_JSON_BYTES) throw new Error("Sync payload is too large");
    assertSyncRole("push", force);
    lease.stage("publishing");
    for (const object of historyObjects) {
      assertSyncRole("push", force); assertActiveHistoryScope(sync, true); assertSyncNotAborted(signal);
      const publication = await publishS3Object(sync, object.artifact.object.key, object.body, signal);
      // Even a non-2xx response follows dispatch, not positive proof of no
      // object-side effects. Never mark such a history failure retry-safe.
      operation.remoteCommit = publication.state === "accepted" ? "partial" : "unknown";
      const pendingItem: SyncItemResult = { side: "remote", scope: "history", id: object.id, state: "unknown", code: "HISTORY_OBJECT_UNCONFIRMED", history: history[object.id],
        message: "History object dispatch may have changed remote storage; its envelope reference has not been published." };
      operation.add(pendingItem); uploadedHistoryItems.set(object.id, pendingItem);
      assertSyncNotAborted(signal); assertSyncRole("push", force); assertActiveHistoryScope(sync, true);
      if (publication.state === "rejected") throw Object.assign(new Error(`History object upload rejected: ${object.id}`), { code: "HISTORY_OBJECT_UNCONFIRMED" });
      const readback = await s3Get(sync, object.artifact.object.key, signal, MAX_HISTORY_OBJECT_BYTES);
      const item = uploadedHistoryItems.get(object.id)!;
      if (readback?.equals(object.body)) {
        operation.remoteCommit = "partial"; item.state = "uploaded"; item.code = "HISTORY_OBJECT_ONLY";
        item.message = "History object bytes verified; no envelope reference has been published yet.";
      }
      assertSyncRole("push", force); assertActiveHistoryScope(sync, true);
      if (item.state !== "uploaded") throw Object.assign(new Error(`History object remote readback mismatch: ${object.id}`), { code: "HISTORY_OBJECT_UNCONFIRMED" });
    }
    for (const extension of extensions) {
      const pkg = fs.readFileSync(extension.packagePath);
      const key = extensionObjectKey(extension.entry);
      const publication = await publishS3Object(sync, key, pkg, signal);
      assertSyncNotAborted(signal);
      if (publication.state !== "accepted") throw new Error(`Extension package was not confirmed uploaded: ${extension.entry.id} (${publication.message})`);
      const readback = await s3Get(sync, key, signal);
      if (!readback || !readback.equals(pkg)) throw new Error(`Extension package remote readback mismatch: ${extension.entry.id}`);
      operation.add({ side: "remote", scope: "extensions", id: extension.entry.id, state: "uploaded", bytes: pkg.length });
    }
    assertSyncNotAborted(signal);
    assertSyncRole("push", force); assertActiveHistoryScope(sync, selectedHistory);
    const publication = await publishS3Object(sync, SYNC_CONFIG_KEY, body, signal);
    operation.remoteCommit = publication.state === "accepted" ? "committed" : "unknown";
    assertSyncNotAborted(signal);
    const observed = await fetchSyncConfig(sync, signal);
    if (!observed.ok || stableStringify(observed.payload) !== stableStringify(document)) {
      throw Object.assign(new Error(`Remote publication could not be verified${observed.ok ? ": snapshot differs" : ": " + observed.message}`), { code: "REMOTE_COMMIT_UNCONFIRMED" });
    }
    operation.remoteCommit = "committed";
    operation.add({ side: "remote", scope: "config", state: "uploaded", bytes: body.length });
    for (const id of ids) operation.add({ side: "remote", scope: "profiles", id, state: "uploaded", identity: compareProfileIdentity(initial.browserProfiles[id], snapshot.browserProfiles[id]),
      message: "Compared current saved configuration with uploaded metadata, not ancestor legacy seed presence or a live runtime fingerprint." });
    for (const [id, coverage] of Object.entries(history)) if (["complete", "empty", "absent"].includes(coverage.state)) {
      const uploaded = uploadedHistoryItems.get(id);
      if (uploaded) { uploaded.code = undefined; uploaded.message = undefined; uploaded.bytes = coverage.artifact?.object.bytes; }
      else operation.add({ side: "remote", scope: "history", id, state: "uploaded", required: selectedHistory, history: coverage, bytes: coverage.artifact?.object.bytes });
    }
    assertSyncRole("push", force); assertActiveHistoryScope(sync, selectedHistory);
    if (publication.state !== "accepted") operation.warnings.push("PUT acknowledgement was unavailable; exact remote snapshot readback confirmed publication.");
    for (const extension of extensions) {
      if (!extension.commitLocalRepair) continue;
      const repaired = await extension.commitLocalRepair();
      if (!repaired) operation.warnings.push(`Extension ${extension.entry.id} changed during upload; the local edit was retained.`);
      else {
        operation.localCommit = "partial";
        for (const warning of repaired.repositoryCommit.cleanupWarnings) operation.warnings.push(warning.message);
      }
    }
    assertSyncNotAborted(signal);
    transact((draft: MgmtConfig) => {
      assertSyncRole("push", force); assertActiveHistoryScope(sync, selectedHistory);
      for (const [id, uploaded] of Object.entries(snapshot.browserProfiles || {})) {
        const current = draft.browserProfiles?.[id];
        if (!current) continue;
        current.syncedAt = uploaded.syncedAt;
        current.syncedHash = uploaded.syncedHash;
        current.syncBaseline = uploaded.syncBaseline;
        if (historyEngine(current) === history[id].engine) {
          current.historySyncCoverage = history[id];
          if (selectedHistory) {
            const baseline = historyBaseline(history[id], targetId);
            if (baseline) current.historySyncBaseline = baseline;
            else delete current.historySyncBaseline;
          }
        }
      }
    });
    operation.localCommit = "committed";
    operation.add({ scope: "baseline", state: "applied" });
    lease.stage("finalizing");
    const sidecars: Array<{ key: string; body: Buffer }> = [];
    for (const [id, encoded] of Object.entries(cookies)) {
      const list = parseCookieBlob(encoded);
      sidecars.push({ key: `cookies-${id}.json`, body: Buffer.from(JSON.stringify({ dirId: id, profileName: getSyncProfileName(snapshot, id),
        timestamp: artifactCapturedAt.cookies[id], capturedAt: artifactCapturedAt.cookies[id], publishedAt: timestamp,
        source: artifactSources.cookies[id], count: list.length, cookies: list })) });
    }
    for (const [id, encoded] of Object.entries(localStorage)) sidecars.push({ key: `localstorage-${id}.tgz`, body: Buffer.from(encoded, "base64") });
    for (const [id, encoded] of Object.entries(preferences)) sidecars.push({ key: `preferences-${id}.json`, body: Buffer.from(encoded, "base64") });
    for (const [id, inventory] of Object.entries(extensionInventories)) {
      sidecars.push({ key: `extensions-${id}.json`, body: Buffer.from(JSON.stringify({ dirId: id, profileName: getSyncProfileName(snapshot, id), timestamp, extensions: inventory })) });
    }
    for (const sidecar of sidecars) {
      assertSyncNotAborted(signal);
      const written = await publishS3Object(sync, sidecar.key, sidecar.body, signal);
      const readback = written.state !== "rejected" && !signal?.aborted ? await s3Get(sync, sidecar.key, signal) : null;
      const verified = readback !== null && readback.equals(sidecar.body);
      operation.add({ side: "remote", scope: "sidecar", id: sidecar.key, state: verified ? "uploaded" : written.state === "rejected" || readback !== null ? "failed" : "unknown", code: verified ? undefined : "COMPAT_SIDECAR_UPLOAD_FAILED" });
      if (!verified) operation.warnings.push(`Authoritative snapshot is published; compatibility sidecar ${sidecar.key} was not confirmed by byte readback.`);
      assertSyncNotAborted(signal);
    }
    result = operation.complete(`Configuration published: ${ids.length} profile configuration(s), ${extensions.length} extension package(s). ${browserBackupIncomplete ? "Browser backup incomplete; running, preserved or unavailable data was not freshly backed up." : "Cookie/LocalStorage coverage is recorded separately; this is not runtime fingerprint proof."}`, body.length + packageBytes);
    if (browserBackupIncomplete) {
      result.browserBackupIncomplete = true;
      result.success = false;
      result.outcome = "partial";
    }
    return result;
  } catch (error: any) {
    result = operation.failure(error, signal?.aborted);
    if (browserBackupIncomplete) result.browserBackupIncomplete = true;
    if (signal?.aborted) { error.syncResult = result; throw error; }
    return result;
  } finally {
    if (stageRoot) {
      try { fs.rmSync(stageRoot, { recursive: true, force: true }); }
      catch (error) { operation.warnings.push(`Owned push staging cleanup failed: ${(error as Error).message}`); }
    }
    if (result) result.warnings = [...operation.warnings];
    lease.finish(result ?? operation.failure(new Error("Sync push ended without a confirmed result")));
  }
}

interface PreparedPullExtension { id: string; remoteEntry: any; packagePath: string; }

function createPullStagingRoot(): string {
  const root = getProfilesDir();
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe profiles staging root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, ".sync-pull-stage-"));
}

async function preparePullExtensions(sync: SyncConfig, remoteConfig: MgmtConfig, stageRoot: string, signal?: AbortSignal, addressed = false): Promise<PreparedPullExtension[]> {
  const remoteEntries = Object.entries(remoteConfig.extensionRepository || {});
  if (remoteEntries.length > MAX_SYNC_EXTENSIONS) throw new Error("Remote config contains too many extensions");
  const localEntries = new Map(listExtensionRepository().map((entry) => [entry.id, entry]));
  const prepared: PreparedPullExtension[] = [];
  let bytes = 0;
  for (const [id, remoteEntry] of remoteEntries) {
    assertSyncNotAborted(signal);
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(id)) throw new Error("Invalid remote extension ID");
    if (!EXTENSION_HASH_RE.test(remoteEntry.packageHash || "") || !EXTENSION_HASH_RE.test(remoteEntry.manifestHash || "")) {
      throw new Error("Remote extension is missing verified hashes");
    }
    const local = localEntries.get(id);
    if (local?.packageHash === remoteEntry.packageHash && local.manifestHash === remoteEntry.manifestHash) continue;
    const suffix = remoteEntry.source === "chrome-web-store" ? "crx" : "zip";
    let pkg = await s3Get(sync, extensionObjectKey({ ...remoteEntry, id }, addressed), signal);
    if (!pkg && !addressed) pkg = await s3Get(sync, `extension-${id}.${suffix === "zip" ? "crx" : "zip"}`, signal);
    if (!pkg) throw new Error(`Remote extension package is unavailable: ${id}`);
    bytes += pkg.length;
    if (bytes > MAX_PULL_EXTENSION_BYTES) throw new Error("Remote extension packages are too large");
    const packagePath = path.join(stageRoot, `package-${randomUUID()}.${suffix}`);
    fs.writeFileSync(packagePath, pkg, { flag: "wx", mode: 0o600 });
    const validationRoot = path.join(stageRoot, `extension-validation-${randomUUID()}`);
    const verified = prepareSyncedExtensionPackage(id, packagePath, remoteEntry, validationRoot, signal);
    fs.rmSync(verified.stagedDir, { recursive: true });
    if (verified.archivePath !== verified.packagePath) fs.rmSync(verified.archivePath);
    fs.rmSync(packagePath);
    prepared.push({ id, remoteEntry, packagePath: verified.packagePath });
  }
  return prepared;
}

// LocalStorage keeps the legacy base64 TGZ envelope. Its exact file inventory
// selects the format; SQLite main/WAL must never be installed below leveldb.
type LocalStorageFormat = "leveldb" | "sqlite";
function localStorageFormat(dirId: string): LocalStorageFormat | "absent" {
  assertProfilePathsSafe(dirId);
  const sqlite = hasSqliteLocalStorage(resolveProfileFile(dirId, "Default"));
  const legacy = fs.lstatSync(resolveProfileFile(dirId, "Default", "Local Storage", "leveldb"), { throwIfNoEntry: false });
  if (sqlite && legacy) throw new Error("Mixed SQLite/LevelDB LocalStorage layouts are not supported");
  return sqlite ? "sqlite" : legacy ? "leveldb" : "absent";
}

async function exportLocalStorage(dirId: string, stageRoot: string, signal?: AbortSignal): Promise<Buffer | null> {
  assertSyncNotAborted(signal);
  assertLocalStorageRestorable(dirId);
  const format = localStorageFormat(dirId);
  if (format === "absent") return null;
  const tmpDir = fs.mkdtempSync(path.join(stageRoot, `ls-export-${dirId.slice(0, 8)}-`));
  try {
    if (format === "sqlite") {
      await captureSqliteLocalStorage(resolveProfileFile(dirId, "Default"), tmpDir, signal);
      const entries: Buffer[] = [];
      for (const name of SQLITE_LOCAL_STORAGE_FILES) {
        const file = path.join(tmpDir, name);
        if (!fs.existsSync(file)) continue;
        const bytes = fs.readFileSync(file);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100, "ascii"); header.write("0000600\0", 100, 8, "ascii");
        header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
        header.fill(0x20, 148, 156); header[156] = 0x30; header.write("ustar\0", 257, 6, "ascii");
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
        entries.push(header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length));
      }
      const tar = Buffer.concat([...entries, Buffer.alloc(1024)]);
      if (tar.length > MAX_LOCAL_STORAGE_TAR_BYTES) throw new Error("SQLite LocalStorage TAR byte limit exceeded");
      const archive = zlib.gzipSync(tar);
      if (archive.length > MAX_LOCAL_STORAGE_TGZ_BYTES) throw new Error("SQLite LocalStorage compressed byte limit exceeded");
      return archive;
    }
    const archiveName = "localstorage.tgz", tmpFile = path.join(tmpDir, archiveName);
    const lsDir = resolveProfileFile(dirId, "Default", "Local Storage", "leveldb");
    // GNU tar treats a drive-colon archive argument as a remote host. Write only
    // a relative name inside this operation's private working directory.
    const result = await spawnTar(["--no-xattrs", "--format", "ustar", "-czf", archiveName, "-C", lsDir, "--exclude", "LOCK", "."], 15000, signal, tmpDir);
    if (!result || !fs.existsSync(tmpFile)) return null;
    assertSyncNotAborted(signal);
    const archive = fs.readFileSync(tmpFile);
    assertSyncNotAborted(signal);
    return archive.length > MAX_LOCAL_STORAGE_TGZ_BYTES ? null : archive;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface PreparedLocalStorage { stagingDir: string; owner: { dev: number; ino: number }; files: number; bytesWritten: number; format: LocalStorageFormat; inventory: Array<{ name: string; hash: string }>; }

async function validateLocalStorageArchive(tgz: Buffer, stagingDir: string, byteBudget: number, signal?: AbortSignal): Promise<{ files: number; bytesWritten: number; format?: "sqlite" }> {
  const extracted = extractSafeLocalStorageArchive(tgz, stagingDir, byteBudget, signal);
  if (extracted.format === "sqlite") await validateStagedSqliteLocalStorage(stagingDir, signal);
  return extracted;
}
function assertLocalStorageFormatCompatible(dirId: string, incoming: LocalStorageFormat): void {
  const current = localStorageFormat(dirId);
  if (current !== "absent" && current !== incoming) throw new Error("Cross-format LocalStorage replacement is not supported; original SQLite/LevelDB data retained");
}

class LocalStorageRecoveryRequiredError extends Error {
  readonly code: string;
  recoveryReceiptPath?: string;
  constructor(readonly dirId: string, readonly recoveryPaths: string[], message: string, readonly localChanged = false, scope: "localStorage" | "history" = "localStorage") {
    super(message); this.code = scope === "history" ? "HISTORY_RECOVERY_REQUIRED" : "LOCAL_STORAGE_RECOVERY_REQUIRED";
  }
}

function localStorageRecoveryReceipt(dirId: string, scope = "localStorage"): string {
  validateDirId(dirId);
  const root = path.join(getAppDataDir(), "sync-recovery");
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe sync recovery directory");
  return path.join(root, `${dirId}.${scope}.json`);
}

function assertHistoryRestorable(dirId: string, engine: BrowserEngine): void {
  assertProfilePathsSafe(dirId);
  const directory = safeExistingParentInsideProfile(dirId, historyPath(engine).split("/"));
  const receipt = localStorageRecoveryReceipt(dirId, "history");
  const recovery = (paths: string[]) => {
    const error = new LocalStorageRecoveryRequiredError(dirId, paths, "History recovery is unresolved; original/new groups retained", false, "history");
    error.recoveryReceiptPath = receipt; return error;
  };
  if (fs.lstatSync(receipt, { throwIfNoEntry: false })) throw recovery([receipt]);
  if (!fs.existsSync(directory)) return;
  sqliteGroupWitnesses(directory, historyBasename(engine));
  for (const name of fs.readdirSync(directory).filter((name) => name.startsWith(".history-backup-"))) {
    const transaction = path.join(directory, name);
    try {
      const stat = fs.lstatSync(transaction);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe history rescue directory");
      const pending = readLocalStorageReceipt(path.join(transaction, "pending.json"));
      const published = readLocalStorageReceipt(path.join(transaction, "published.json"));
      if (pending.version !== 1 || pending.dirId !== dirId || pending.scope !== "history" || pending.target !== directory ||
          published.state !== "published" || published.pendingHash !== sha256Hex(JSON.stringify(pending)) ||
          fs.lstatSync(path.join(transaction, "recovery-required.json"), { throwIfNoEntry: false })) throw new Error("Unresolved history rescue directory");
    } catch { throw recovery([transaction]); }
  }
}

function assertLocalStorageRestorable(dirId: string): void {
  assertProfilePathsSafe(dirId);
  const target = resolveProfileFile(dirId, "Default", "Local Storage", "leveldb");
  const parent = safeExistingParentInsideProfile(dirId, ["Default", "Local Storage", "leveldb"]);
  const backups = fs.existsSync(parent) ? fs.readdirSync(parent).filter((name) => name.startsWith(".leveldb-backup-")).map((name) => path.join(parent, name)) : [];
  const receipt = localStorageRecoveryReceipt(dirId);
  if (fs.lstatSync(receipt, { throwIfNoEntry: false }) || (!fs.existsSync(target) && backups.length)) {
    const error = new LocalStorageRecoveryRequiredError(dirId, backups, "LocalStorage recovery is unresolved; refusing to overwrite its rescue copies");
    error.recoveryReceiptPath = receipt;
    throw error;
  }
  assertSqliteRecoveryResolved(dirId);
}

async function prepareLocalStorage(dirId: string, tgzData: Buffer, stageRoot: string, remainingByteBudget: number, signal?: AbortSignal): Promise<PreparedLocalStorage> {
  assertLocalStorageRestorable(dirId);
  const stagingDir = fs.mkdtempSync(path.join(stageRoot, `ls-stage-${dirId.slice(0, 8)}-`));
  const extracted = await validateLocalStorageArchive(tgzData, stagingDir, remainingByteBudget, signal);
  const format = extracted.format || "leveldb";
  if (extracted.files && !isProfileRunningForRestore(dirId)) assertLocalStorageFormatCompatible(dirId, format);
  const inventory = fs.readdirSync(stagingDir).sort().map((name) => ({ name, hash: localStorageFileWitness(path.join(stagingDir, name), signal).hash }));
  const owner = fs.lstatSync(stagingDir);
  return { stagingDir, owner: { dev: owner.dev, ino: owner.ino }, ...extracted, format, inventory };
}

function localStorageFileWitness(file: string, signal?: AbortSignal): { stat: fs.Stats; hash: string } {
  assertSyncNotAborted(signal);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_LOCAL_STORAGE_TAR_BYTES) throw new Error("Unsafe LocalStorage file witness");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const same = (stat: fs.Stats) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.mode === before.mode && stat.nlink === before.nlink && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
  try {
    if (!same(fs.fstatSync(fd))) throw new Error("LocalStorage file changed before verification");
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < before.size;) {
      assertSyncNotAborted(signal);
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!n) throw new Error("LocalStorage file changed during verification");
      hash.update(chunk.subarray(0, n)); offset += n;
    }
    if (fs.readSync(fd, chunk, 0, 1, before.size) || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) throw new Error("LocalStorage file changed during verification");
    return { stat: before, hash: hash.digest("hex") };
  } finally { fs.closeSync(fd); }
}
function assertPreparedLocalStorage(prepared: PreparedLocalStorage, signal?: AbortSignal): void {
  const stat = fs.lstatSync(prepared.stagingDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== prepared.owner.dev || stat.ino !== prepared.owner.ino) throw new Error("Unsafe or replaced LocalStorage staging directory");
  const names = fs.readdirSync(prepared.stagingDir).sort();
  if (JSON.stringify(names) !== JSON.stringify(prepared.inventory.map((item) => item.name))) throw new Error("LocalStorage staging inventory changed");
  for (const entry of prepared.inventory) {
    if (localStorageFileWitness(path.join(prepared.stagingDir, entry.name), signal).hash !== entry.hash) throw new Error("LocalStorage staging bytes changed");
  }
}

function importLocalStorage(dirId: string, prepared: PreparedLocalStorage, operationId: string, signal?: AbortSignal): { imported: boolean; bytesWritten: number; backupDir?: string } {
  assertSyncNotAborted(signal);
  assertLocalStorageRestorable(dirId);
  if (!prepared.files || isProfileRunningForRestore(dirId)) return { imported: false, bytesWritten: 0 };
  assertPreparedLocalStorage(prepared, signal);
  assertLocalStorageFormatCompatible(dirId, prepared.format);
  if (prepared.format === "sqlite") return importSqliteLocalStorage(dirId, prepared, operationId, signal);
  const lsDir = resolveProfileFile(dirId, "Default", "Local Storage", "leveldb");
  const parentDir = safeExistingParentInsideProfile(dirId, ["Default", "Local Storage", "leveldb"]);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (fs.statSync(prepared.stagingDir).dev !== fs.statSync(parentDir).dev) {
    throw Object.assign(new Error("LocalStorage staging must be on the destination filesystem"), { code: "EXDEV" });
  }
  let backupDir: string | undefined;
  if (fs.existsSync(lsDir)) {
    backupDir = path.join(parentDir, `.leveldb-backup-${operationId}`);
    fs.renameSync(lsDir, backupDir);
  }
  try {
    assertSyncNotAborted(signal);
    fs.renameSync(prepared.stagingDir, lsDir);
  } catch (error) {
    if (backupDir) {
      try {
        fs.renameSync(backupDir, lsDir);
      } catch (rollbackError) {
        const recovery = new LocalStorageRecoveryRequiredError(dirId, [backupDir], "LocalStorage publication and compensation failed; the original database is retained for recovery", true);
        try {
          const receipt = localStorageRecoveryReceipt(dirId);
          fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
          const fd = fs.openSync(receipt, "wx", 0o600);
          try {
            fs.writeFileSync(fd, JSON.stringify({ operationId, dirId, state: "recovery-required", backupDir, target: lsDir }));
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          recovery.recoveryReceiptPath = receipt;
        } catch (receiptError) {
          console.error("[sync] rescue copy retained but recovery receipt could not be persisted:", receiptError);
        }
        console.error("[sync] LocalStorage compensation failed:", rollbackError);
        throw recovery;
      }
    }
    throw error;
  }
  // A parseable archive is not proof that Chromium can open the database.
  // Keep the previous copy until a separately verified recovery/cleanup action.
  return { imported: true, bytesWritten: prepared.bytesWritten, backupDir };
}

function syncLocalStorageDirectory(directory: string): void {
  if (!syncArchiveDirectory(directory)) throw new Error("SQLite LocalStorage directory durability is unsupported on this filesystem");
}
function readLocalStorageReceipt(file: string): Record<string, any> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error("Unsafe LocalStorage recovery receipt");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("LocalStorage recovery receipt changed");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("LocalStorage recovery receipt changed");
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid LocalStorage recovery receipt");
    return value;
  } finally { fs.closeSync(fd); }
}
function assertSqliteRecoveryResolved(dirId: string): void {
  const directory = resolveProfileFile(dirId, "Default");
  if (!fs.existsSync(directory)) return;
  const backups = fs.readdirSync(directory).filter((name) => name.startsWith(".sqlite-localstorage-backup-"));
  for (const name of backups) {
    const transaction = path.join(directory, name);
    try {
      const stat = fs.lstatSync(transaction);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe SQLite rescue directory");
      const pending = readLocalStorageReceipt(path.join(transaction, "pending.json"));
      const published = readLocalStorageReceipt(path.join(transaction, "published.json"));
      if (pending.version !== 1 || pending.dirId !== dirId || pending.format !== "sqlite" || pending.target !== directory ||
          published.state !== "published" || published.pendingHash !== createHash("sha256").update(JSON.stringify(pending)).digest("hex") ||
          fs.lstatSync(path.join(transaction, "recovery-required.json"), { throwIfNoEntry: false }) || !hasSqliteLocalStorage(directory)) throw new Error("Unresolved SQLite rescue directory");
    } catch {
      throw new LocalStorageRecoveryRequiredError(dirId, [transaction], "SQLite LocalStorage recovery is unresolved; refusing to overwrite its rescue copies");
    }
  }
}

/** Same-volume multi-file publication. Every rescue/new byte lives OUTSIDE the
 * pull stage before the first live move, so its finally cleanup cannot destroy
 * the only copy after failed compensation. Journals are append-only/exclusive. */
interface HistoryPublicationPolicy { engine: BrowserEngine; guard: () => void; }
function importSqliteLocalStorage(dirId: string, prepared: PreparedLocalStorage, operationId: string, signal?: AbortSignal, policy?: HistoryPublicationPolicy): { imported: boolean; bytesWritten: number; backupDir?: string; rollback?: () => void } {
  const directory = safeExistingParentInsideProfile(dirId, policy ? historyPath(policy.engine).split("/") : ["Default", "LocalStorage"]);
  const names: readonly string[] = policy ? historySidecars(policy.engine) : SQLITE_LOCAL_STORAGE_SIDECARS;
  const scope = policy ? "history" : "localStorage";
  const original = new Map<string, ReturnType<typeof localStorageFileWitness>>();
  for (const name of names) {
    const file = path.join(directory, name);
    if (fs.lstatSync(file, { throwIfNoEntry: false })) original.set(name, localStorageFileWitness(file, signal));
  }
  if (fs.statSync(prepared.stagingDir).dev !== fs.statSync(directory).dev) throw Object.assign(new Error("LocalStorage staging must be on the destination filesystem"), { code: "EXDEV" });
  const transaction = fs.mkdtempSync(path.join(directory, policy ? ".history-backup-" : ".sqlite-localstorage-backup-"));
  const owner = fs.lstatSync(transaction);
  const oldDir = path.join(transaction, "old"), newDir = path.join(transaction, "new");
  let oldOwner: fs.Stats | undefined, newOwner: { dev: number; ino: number } | undefined;
  const moved: string[] = [];
  const published = new Map<string, ReturnType<typeof localStorageFileWitness>>();
  const ownerCheck = () => {
    assertProfilePathsSafe(dirId);
    const current = fs.lstatSync(transaction);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("LocalStorage transaction owner changed");
    for (const [folder, expected] of [[oldDir, oldOwner], [newDir, newOwner]] as const) {
      const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
      if (expected ? !stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino : stat !== undefined) throw new Error("LocalStorage transaction folder owner changed");
    }
  };
  const checkOriginal = (name: string, file: string) => {
    const expected = original.get(name)!;
    const actual = localStorageFileWitness(file);
    if (actual.stat.dev !== expected.stat.dev || actual.stat.ino !== expected.stat.ino || actual.stat.mode !== expected.stat.mode ||
        actual.stat.size !== expected.stat.size || actual.stat.mtimeMs !== expected.stat.mtimeMs ||
        !moved.includes(name) && actual.stat.ctimeMs !== expected.stat.ctimeMs || actual.hash !== expected.hash) throw new Error("Existing SQLite LocalStorage changed during publication");
  };
  const checkDestination = () => {
    ownerCheck(); policy?.guard();
    if (!policy && fs.lstatSync(resolveProfileFile(dirId, "Default", "Local Storage", "leveldb"), { throwIfNoEntry: false })) throw new Error("LocalStorage format changed during publication");
    for (const name of names) {
      const file = path.join(directory, name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
      const own = published.get(name);
      if (own) {
        if (!stat || stat.dev !== own.stat.dev || stat.ino !== own.stat.ino || localStorageFileWitness(file).hash !== own.hash) throw new Error("Published SQLite LocalStorage changed");
      } else if (original.has(name) && !moved.includes(name)) checkOriginal(name, file);
      else if (stat) throw new Error("SQLite LocalStorage destination appeared during publication");
    }
  };
  try {
    fs.mkdirSync(oldDir, { mode: 0o700 }); oldOwner = fs.lstatSync(oldDir);
    ownerCheck();
    const pending = { version: 1, format: "sqlite", ...(policy ? { scope } : {}), operationId, dirId, target: directory,
      old: [...original].map(([name, value]) => ({ name, hash: value.hash })), incoming: prepared.inventory };
    writeOwnedSqliteFile(path.join(transaction, "pending.json"), Buffer.from(JSON.stringify(pending)));
    syncLocalStorageDirectory(transaction); syncLocalStorageDirectory(directory);
    ownerCheck();
    fs.renameSync(prepared.stagingDir, newDir); newOwner = prepared.owner;
    ownerCheck(); syncLocalStorageDirectory(transaction);
    assertPreparedLocalStorage({ ...prepared, stagingDir: newDir }, signal);
    for (const name of original.keys()) {
      assertSyncNotAborted(signal); checkDestination();
      fs.renameSync(path.join(directory, name), path.join(oldDir, name));
      moved.push(name);
      checkOriginal(name, path.join(oldDir, name));
      syncLocalStorageDirectory(oldDir); syncLocalStorageDirectory(directory);
    }
    for (const entry of prepared.inventory) {
      assertSyncNotAborted(signal); checkDestination();
      const from = path.join(newDir, entry.name), target = path.join(directory, entry.name);
      const witness = localStorageFileWitness(from, signal);
      if (witness.hash !== entry.hash) throw new Error("SQLite LocalStorage staged bytes changed before publication");
      // Atomic no-clobber: never rename over a file that appeared after preflight.
      fs.linkSync(from, target); published.set(entry.name, witness);
      fs.unlinkSync(from);
      if (localStorageFileWitness(target, signal).hash !== entry.hash) throw new Error("SQLite LocalStorage publication readback mismatch");
      syncLocalStorageDirectory(newDir); syncLocalStorageDirectory(directory);
    }
    checkDestination(); assertSyncNotAborted(signal);
    writeOwnedSqliteFile(path.join(transaction, "published.json"), Buffer.from(JSON.stringify({ state: "published", pendingHash: createHash("sha256").update(JSON.stringify(pending)).digest("hex") })));
    syncLocalStorageDirectory(transaction); syncLocalStorageDirectory(directory);
    // Old main/WAL/SHM remain together. Native quick_check is not Chromium
    // runtime proof and does not authorize deleting the previous database.
    return { imported: true, bytesWritten: prepared.bytesWritten, ...(original.size ? { backupDir: oldDir } : {}),
      ...(policy ? { rollback: () => {
        const cancelled = new Error("History publication compensated before config commit");
        try { compensate(cancelled); } catch (error) { if (error !== cancelled) throw error; }
      } } : {}) };
  } catch (publicationError) { return compensate(publicationError); }
  function compensate(publicationError: unknown): never {
    const compensationErrors: unknown[] = [];
    for (const [name, witness] of [...published].reverse()) {
      try {
        ownerCheck(); if (policy) assertHistoryStopped(dirId);
        const target = path.join(directory, name), retained = path.join(newDir, name);
        const actual = fs.lstatSync(target);
        if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== witness.stat.dev || actual.ino !== witness.stat.ino) throw new Error("Published SQLite file owner changed; retaining both copies");
        const existing = fs.lstatSync(retained, { throwIfNoEntry: false });
        if (existing) {
          if (existing.dev !== actual.dev || existing.ino !== actual.ino) throw new Error("SQLite new rescue target already exists");
          fs.unlinkSync(target); // retained is this same owned inode (link succeeded, unlink had failed)
        } else {
          if (localStorageFileWitness(target).hash !== witness.hash) throw new Error("Published SQLite file was edited; retaining it for recovery");
          fs.renameSync(target, retained);
        }
      } catch (error) { compensationErrors.push(error); }
    }
    for (const name of [...moved].reverse()) {
      try {
        ownerCheck(); if (policy) assertHistoryStopped(dirId);
        const old = path.join(oldDir, name), target = path.join(directory, name);
        const stat = fs.lstatSync(old), expected = original.get(name)!.stat;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("SQLite old rescue file owner changed");
        fs.linkSync(old, target); // no-clobber, including when another owner created a target
        fs.unlinkSync(old);
      } catch (error) { compensationErrors.push(error); }
    }
    if (!compensationErrors.length) {
      try {
        ownerCheck(); syncLocalStorageDirectory(directory);
        // Only exclusively-created transaction material is eligible for cleanup.
        const allowed = new Set(["old", "new", "pending.json", "published.json"]);
        for (const name of fs.readdirSync(transaction)) if (!allowed.has(name)) throw new Error("Unexpected LocalStorage transaction material; retaining it");
        for (const [folder, names] of [[oldDir, []], [newDir, prepared.inventory.map((item) => item.name)]] as Array<[string, string[]]>) {
          if (!fs.existsSync(folder)) continue;
          const stat = fs.lstatSync(folder);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe LocalStorage transaction folder");
          for (const name of fs.readdirSync(folder)) {
            if (!names.includes(name)) throw new Error("Unexpected LocalStorage rescue material");
            const entry = prepared.inventory.find((item) => item.name === name)!;
            if (localStorageFileWitness(path.join(folder, name)).hash !== entry.hash) throw new Error("LocalStorage rescue material changed; retained");
          }
        }
        fs.rmSync(transaction, { recursive: true });
        syncLocalStorageDirectory(directory);
      } catch (error) { compensationErrors.push(error); }
    }
    if (compensationErrors.length) {
      const recovery = new LocalStorageRecoveryRequiredError(dirId, [transaction, directory], `SQLite ${scope} publication/compensation is incomplete; old/new material retained for recovery`, true, scope);
      const receiptData = Buffer.from(JSON.stringify({ operationId, dirId, state: "recovery-required", format: "sqlite", transaction, target: directory,
        old: [...original].map(([name, value]) => ({ name, hash: value.hash, backupPath: path.join(oldDir, name), livePath: path.join(directory, name) })),
        incoming: prepared.inventory.map((entry) => ({ ...entry, retainedPath: path.join(newDir, entry.name), livePath: path.join(directory, entry.name) })),
      }));
      try {
        ownerCheck();
        writeOwnedSqliteFile(path.join(transaction, "recovery-required.json"), receiptData);
        syncLocalStorageDirectory(transaction); syncLocalStorageDirectory(directory);
      } catch (error) { console.error("[sync] SQLite transaction recovery journal not confirmed durable:", error); }
      try {
        const receipt = localStorageRecoveryReceipt(dirId, scope);
        fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
        writeOwnedSqliteFile(receipt, receiptData); syncLocalStorageDirectory(path.dirname(receipt));
        recovery.recoveryReceiptPath = receipt;
      } catch (error) { console.error("[sync] SQLite recovery receipt not confirmed durable; transaction pending marker retained:", error); }
      throw recovery;
    }
    throw publicationError;
  }
}

function spawnTar(args: string[], timeoutMs: number, signal?: AbortSignal, cwd?: string): Promise<boolean> {
  assertSyncNotAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: "ignore", ...(cwd ? { cwd } : {}) });
    let settled = false, stopRequested = false, timedOut = false, terminalError: Error | undefined;
    const recordError = (error: Error) => {
      if (settled) return;
      if (!terminalError) terminalError = error;
      else {
        const previous = terminalError;
        terminalError = Object.assign(new AggregateError([previous, error], previous.message, { cause: previous }), { code: (previous as NodeJS.ErrnoException).code });
      }
    };
    const finish = (ok: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(ok);
    };
    const requestStop = (error?: Error) => {
      if (settled) return;
      if (error) recordError(error);
      if (stopRequested) return;
      stopRequested = true;
      // A termination request (including false/throw) is not proof of exit.
      // Retain the caller's lease and staging until the real close event.
      try { child.kill("SIGTERM"); } catch (failure) { recordError(failure as Error); }
    };
    const onAbort = () => requestStop(Object.assign(new Error("Sync operation cancelled"), { code: "ABORT_ERR" }));
    const timer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);
    child.on("error", recordError);
    child.on("close", (code) => finish(code === 0 && !stopRequested && !timedOut, terminalError));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function resolveProfileDir(dirId: string): string {
  validateDirId(dirId);
  const baseDir = path.resolve(getProfilesDir());
  const profileDir = path.resolve(baseDir, dirId);
  if (!isPathInside(profileDir, baseDir)) {
    throw new Error(`Profile path escapes profiles directory: ${JSON.stringify(dirId)}`);
  }
  return profileDir;
}

function resolveProfileFile(dirId: string, ...segments: string[]): string {
  const profileDir = resolveProfileDir(dirId);
  const filePath = path.resolve(profileDir, ...segments);
  if (!isPathInside(filePath, profileDir)) {
    throw new Error(`Profile file path escapes profile: ${JSON.stringify(segments.join("/"))}`);
  }
  return filePath;
}

function assertProfilePathsSafe(dirId: string): void {
  const profileDir = resolveProfileDir(dirId);
  for (const p of [getProfilesDir(), profileDir, path.join(profileDir, "Default"), path.join(profileDir, "Default", "Local Storage"), path.join(profileDir, "Default", "Local Storage", "leveldb")]) {
    const stat = fs.lstatSync(p, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe profile directory: ${dirId}`);
  }
  const prefs = fs.lstatSync(path.join(profileDir, "Default", "Preferences"), { throwIfNoEntry: false });
  if (prefs && (!prefs.isFile() || prefs.isSymbolicLink())) throw new Error(`Unsafe profile Preferences path: ${dirId}`);
  for (const name of SQLITE_LOCAL_STORAGE_SIDECARS) {
    const stat = fs.lstatSync(path.join(profileDir, "Default", name), { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Unsafe profile SQLite LocalStorage path: ${dirId}`);
  }
}

function ensureProfileDefaultDir(dirId: string): void {
  assertProfilePathsSafe(dirId);
  fs.mkdirSync(resolveProfileFile(dirId, "Default"), { recursive: true, mode: 0o700 });
}

function safeExistingParentInsideProfile(dirId: string, targetSegments: string[]): string {
  assertProfilePathsSafe(dirId);
  const profileDir = resolveProfileDir(dirId);
  const profileReal = fs.existsSync(profileDir) ? fs.realpathSync(profileDir) : profileDir;
  let current = profileDir;
  for (const segment of targetSegments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Profile path contains symlink: ${dirId}`);
    const real = fs.realpathSync(current);
    if (!isPathInside(real, profileReal)) throw new Error(`Profile path escapes profiles directory: ${dirId}`);
  }
  return path.dirname(resolveProfileFile(dirId, ...targetSegments));
}

function extractSafeLocalStorageArchive(tgzData: Buffer, targetRoot: string, byteBudget = MAX_PULL_LOCAL_STORAGE_BYTES, signal?: AbortSignal): { files: number; bytesWritten: number; format?: "sqlite" } {
  assertSyncNotAborted(signal);
  if (tgzData.length > MAX_LOCAL_STORAGE_TGZ_BYTES || !Number.isSafeInteger(byteBudget) || byteBudget <= 0) {
    throw new Error("LocalStorage archive exceeds pull byte budget");
  }
  const tarData = zlib.gunzipSync(tgzData, { maxOutputLength: Math.min(MAX_LOCAL_STORAGE_TAR_BYTES, byteBudget + (MAX_LOCAL_STORAGE_FILES + 4) * 1024) });
  if (tarData.length % 512 !== 0) throw new Error("LocalStorage archive has a truncated TAR block");
  let offset = 0;
  let bytesWritten = 0;
  let terminated = false;
  const entries: Array<{ path: string; start: number; end: number }> = [];
  const names = new Set<string>();
  let canonicalSqliteNames = true;
  let sawDirectory = false;
  const rootStat = fs.lstatSync(targetRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe LocalStorage staging directory");
  const rootReal = fs.realpathSync(targetRoot);

  while (offset + 512 <= tarData.length) {
    assertSyncNotAborted(signal);
    const header = tarData.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      if (offset + 1024 > tarData.length || !isZeroBlock(tarData.subarray(offset))) {
        throw new Error("LocalStorage archive has incomplete TAR end markers");
      }
      terminated = true;
      break;
    }
    const expectedChecksum = readTarOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (actualChecksum !== expectedChecksum) throw new Error("LocalStorage archive TAR checksum mismatch");
    const rawName = readTarString(header, 0, 100), rawPrefix = readTarString(header, 345, 155);
    const entryPath = normalizeTarEntryPath(rawName, rawPrefix);
    const canonicalName = Buffer.alloc(100); canonicalName.write(entryPath, 0, 100, "utf8");
    canonicalSqliteNames &&= rawName === entryPath && rawPrefix === "" && header.subarray(0, 100).equals(canonicalName) && isZeroBlock(header.subarray(345, 500));
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    if (typeFlag === "5") sawDirectory = true;
    const size = readTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || size < 0 || nextOffset > tarData.length) throw new Error("LocalStorage archive has invalid entry size");
    if (typeFlag !== "0" && typeFlag !== "5") throw new Error("LocalStorage archive contains non-regular entries");
    if (!isAllowedLocalStoragePath(entryPath) || (typeFlag === "5" && (entryPath !== "" || size !== 0))) {
      throw new Error("LocalStorage archive contains unsafe paths");
    }
    if (names.has(entryPath)) throw new Error("LocalStorage archive contains duplicate paths");
    names.add(entryPath);
    if (typeFlag === "0") {
      if (!entryPath) throw new Error("LocalStorage archive contains an unnamed file");
      bytesWritten += size;
      if (bytesWritten > byteBudget) throw new Error("LocalStorage archive exceeds pull byte budget");
      if (entries.length >= MAX_LOCAL_STORAGE_FILES) throw new Error("LocalStorage archive contains too many files");
      entries.push({ path: entryPath, start: dataStart, end: dataEnd });
    }
    offset = nextOffset;
  }
  if (!terminated) throw new Error("LocalStorage archive is missing TAR end markers");
  const sqlite = entries.some((entry) => entry.path === "LocalStorage" || entry.path === "LocalStorage-wal");
  if (sqlite) {
    if (!canonicalSqliteNames || sawDirectory || entries.some((entry) => !SQLITE_LOCAL_STORAGE_FILES.includes(entry.path as typeof SQLITE_LOCAL_STORAGE_FILES[number]))) throw new Error("Mixed or noncanonical SQLite LocalStorage archive");
    const main = entries.find((entry) => entry.path === "LocalStorage");
    const wal = entries.find((entry) => entry.path === "LocalStorage-wal");
    if (!main) throw new Error("Orphan SQLite LocalStorage WAL without main database");
    validateSqliteLocalStorageGroup(tarData.subarray(main.start, main.end), wal ? tarData.subarray(wal.start, wal.end) : undefined, signal);
  } else if (entries.length) {
    const current = entries.find((entry) => entry.path === "CURRENT");
    if (!current || current.end - current.start > 256) throw new Error("LocalStorage archive is missing a valid CURRENT manifest reference");
    const manifest = tarData.subarray(current.start, current.end).toString("utf8");
    if (!/^MANIFEST-[0-9]+\n$/.test(manifest) || !entries.some((entry) => entry.path === manifest.trim())) {
      throw new Error("LocalStorage CURRENT refers to a missing or invalid MANIFEST");
    }
  }

  // All headers, references and limits are checked before the first file write.
  for (const entry of entries) {
    assertSyncNotAborted(signal);
    const target = path.resolve(rootReal, entry.path);
    if (!isPathInside(target, rootReal)) throw new Error("LocalStorage archive escapes extraction directory");
    if (sqlite) writeOwnedSqliteFile(target, tarData.subarray(entry.start, entry.end));
    else {
      fs.writeFileSync(target, tarData.subarray(entry.start, entry.end), { flag: "wx", mode: 0o600 });
      if (!fs.readFileSync(target).equals(tarData.subarray(entry.start, entry.end))) throw new Error("LocalStorage staging readback mismatch");
    }
  }
  return { files: entries.length, bytesWritten, ...(sqlite ? { format: "sqlite" as const } : {}) };
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function readTarString(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf-8");
}

function readTarOctal(header: Buffer, start: number, length: number): number {
  const raw = readTarString(header, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error("LocalStorage archive has invalid tar size");
  return Number.parseInt(raw, 8);
}

function normalizeTarEntryPath(name: string, prefix: string): string {
  const combined = prefix ? `${prefix}/${name}` : name;
  const normalized = path.posix.normalize(combined.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (normalized === ".") return "";
  if (path.posix.isAbsolute(combined) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("LocalStorage archive contains unsafe paths");
  }
  return normalized.replace(/\/$/, "");
}

function isAllowedLocalStoragePath(entry: string): boolean {
  if (!entry) return true;
  return /^(CURRENT|MANIFEST-[0-9]+|[0-9]+\.(ldb|sst|log)|LOG(?:\.old)?|IDENTITY|LocalStorage(?:-wal)?)$/.test(entry);
}

function validatePreferencesJson(rawPrefs: Buffer): void {
  if (rawPrefs.length > MAX_PREFERENCES_JSON_BYTES) throw new Error("Preferences JSON is too large");
  const prefs = JSON.parse(rawPrefs.toString("utf-8"));
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) throw new Error("Preferences JSON must be an object");
  assertJsonShape(prefs, 0, { nodes: 0 });
}

function assertJsonShape(value: unknown, depth: number, state: { nodes: number }): void {
  state.nodes++;
  if (state.nodes > 100000) throw new Error("Preferences JSON has too many values");
  if (depth > 80) throw new Error("Preferences JSON is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 20000) throw new Error("Preferences JSON array is too large");
    for (const item of value) assertJsonShape(item, depth + 1, state);
    return;
  }
  if (typeof value !== "object") throw new Error("Preferences JSON contains invalid values");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20000) throw new Error("Preferences JSON object is too large");
  for (const [key, item] of entries) {
    if (key.length > 512 || /[\x00-\x08\x0e-\x1f\x7f]/.test(key) || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Preferences JSON contains unsafe keys");
    }
    assertJsonShape(item, depth + 1, state);
  }
}

function writeFileAtomic(filePath: string, data: Buffer): void {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!fs.readFileSync(tmp).equals(data)) throw new Error("Preferences staging readback mismatch");
    fs.renameSync(tmp, filePath);
    published = true;
  } finally {
    if (!published) {
      try { fs.rmSync(tmp, { force: true }); } catch (error) { console.error("[sync] could not remove uncommitted Preferences staging file:", error); }
    }
  }
}

function isProfileRunningForRestore(dirId: string): boolean {
  validateDirId(dirId);
  try {
    assertProfileTransferStopped(dirId, () => statusBrowser(dirId), () => runtimeCookieOps.hasRunningBrowser(dirId), { engine: getConfig().browserProfiles?.[dirId]?.engine });
    return false;
  } catch (error) {
    if ((error as { code?: string })?.code !== "PROFILE_STOP_REQUIRED") throw error;
    return true;
  }
}

function decodeBase64Field(value: unknown, maxBytes: number, label: string): Buffer {
  if (typeof value !== "string") throw new Error(`${label} must be a base64 string`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error(`${label} must be valid base64`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length > maxBytes) throw new Error(`${label} is too large`);
  return decoded;
}

function gunzipBase64Field(value: unknown, maxCompressedBytes: number, maxOutputBytes: number, label: string): Buffer {
  const compressed = decodeBase64Field(value, maxCompressedBytes, label);
  return zlib.gunzipSync(compressed, { maxOutputLength: maxOutputBytes });
}

function parseCookieBlob(value: unknown): CookieInfo[] {
  const parsed = JSON.parse(gunzipBase64Field(value, MAX_COOKIES_GZIP_BYTES, MAX_COOKIES_JSON_BYTES, "cookies").toString());
  if (!Array.isArray(parsed)) throw new Error("cookies must be an array");
  if (parsed.length > MAX_COOKIE_COUNT) throw new Error("cookies array is too large");
  return parsed.map(normalizeCookieForSync);
}

function isValidCookieBlob(value: unknown): value is string {
  try {
    parseCookieBlob(value);
    return true;
  } catch (e) {
    console.error("[sync] skipped invalid remote cookie blob:", e);
    return false;
  }
}

function normalizeCookieForSync(cookie: any): CookieInfo {
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) throw new Error("invalid cookie entry");
  const domain = boundedCookieText(cookie.domain, 255, "domain");
  const name = boundedCookieText(cookie.name, 255, "name");
  const value = boundedCookieText(cookie.value === undefined ? "" : cookie.value, 4096, "value", true);
  const cookiePath = boundedCookieText(cookie.path === undefined ? "/" : cookie.path, 1024, "path");
  for (const flag of ["secure", "httpOnly"]) {
    if (cookie[flag] !== undefined && typeof cookie[flag] !== "boolean") throw new Error(`invalid cookie ${flag}`);
  }
  if (cookie.sameSite !== undefined && (!Number.isInteger(cookie.sameSite) || cookie.sameSite < 0 || cookie.sameSite > 2)) throw new Error("invalid cookie sameSite");
  const expires = cookie.expires === null || cookie.expires === undefined ? null : cookie.expires;
  if (expires !== null && (typeof expires !== "number" || !Number.isFinite(expires) || expires < -1 || expires > 4102444800)) throw new Error("invalid cookie expiry");
  const normalized = normalizeCookieForQueue({
    domain,
    name,
    value,
    path: cookiePath,
    expires,
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite ?? 0,
  });
  if (!normalized) throw new Error("Cookie cannot be represented safely in the import queue");
  return normalized;
}

function boundedCookieText(value: unknown, maxLength: number, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`invalid cookie ${field}`);
  if ((!allowEmpty && !value) || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`invalid cookie ${field}`);
  return value;
}

function isPathInside(childPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectRemoteLocksBlockingPush(sync: ReturnType<typeof getSyncConfig>, signal?: AbortSignal, fetchedSnapshot?: Awaited<ReturnType<typeof fetchSyncConfig>>): Promise<Array<{ id: string; ownerName: string }>> {
  const myDevice = getConfig().deviceId || "local";
  const fetched = fetchedSnapshot ?? await fetchSyncConfig(sync, signal);
  if (!fetched.ok) {
    if (fetched.message.startsWith("HTTP 404")) return [];
    throw new Error(`Cannot verify remote profile locks: ${fetched.message}`);
  }
  const raw = gunzipBase64Field(fetched.payload.data, MAX_CONFIG_GZIP_BYTES, MAX_CONFIG_JSON_BYTES, "sync config");
  const remoteCfg = sanitizeRemoteConfig(JSON.parse(raw.toString()) as MgmtConfig);
  validateArtifactProfileIds(fetched.payload, new Set(Object.keys(remoteCfg.browserProfiles || {})));
  parseRemoteHistory(fetched.payload, remoteCfg.browserProfiles || {});
  const out: Array<{ id: string; ownerName: string }> = [];
  for (const [id, p] of Object.entries(remoteCfg.browserProfiles || {}) as Array<[string, any]>) {
    const lock = p?.lock;
    if (lock && typeof lock.owner === "string" && lock.owner && lock.owner !== myDevice) {
      out.push({ id, ownerName: String(lock.ownerName || lock.owner) });
    }
  }
  return out;
}

async function fetchSyncConfig(sync: ReturnType<typeof getSyncConfig>, signal?: AbortSignal): Promise<{ ok: true; payload: any } | { ok: false; message: string }> {
  const payload = await fetchSyncPayload(sync, SYNC_CONFIG_KEY, false, signal);
  if (payload.ok || !payload.message.startsWith("HTTP 404")) return payload;
  return fetchSyncPayload(sync, LEGACY_SYNC_CONFIG_KEY, false, signal);
}

async function fetchRemoteCookiesForPush(sync: ReturnType<typeof getSyncConfig>, signal?: AbortSignal): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  try {
    let fetched = await fetchSyncPayload(sync, SYNC_CONFIG_KEY, true, signal);
    if (!fetched.ok && fetched.message.startsWith("HTTP 404")) {
      fetched = await fetchSyncPayload(sync, LEGACY_SYNC_CONFIG_KEY, true, signal);
    }
    if (fetched.ok && fetched.payload.cookies && typeof fetched.payload.cookies === "object") {
      for (const [dirId, blob] of Object.entries(fetched.payload.cookies)) {
        validateDirId(dirId);
        if (isValidCookieBlob(blob)) merged[dirId] = blob as string;
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    console.error(`[sync] failed to read remote cookies:`, e);
  }
  return merged;
}

async function fetchSyncPayload(sync: ReturnType<typeof getSyncConfig>, key: string, cookiesOnly = false, signal?: AbortSignal): Promise<{ ok: true; payload: any } | { ok: false; message: string }> {
  assertSyncNotAborted(signal);
  const objPath = `/${sync.bucket}/${key}`;
  const url = `${sync.endpoint}${objPath}`;
  const headers = signS3Request({
    method: "GET",
    endpoint: sync.endpoint,
    objectPath: objPath,
    accessKey: sync.accessKey,
    secretKey: decryptSecretOr(sync.secretKey),
  });
  const resp = await fetch(url, { method: "GET", headers, signal: combineAbortSignals(signal, 30000) });
  if (!resp.ok) {
    const detail = await readS3ErrorDetail(resp);
    return { ok: false, message: `HTTP ${resp.status}${detail ? `: ${detail}` : ""}` };
  }
  const length = Number(resp.headers.get("content-length") || "0");
  if (length > MAX_REMOTE_PAYLOAD_JSON_BYTES) return { ok: false, message: "Remote config is too large" };
  const payload = JSON.parse(await readResponseTextLimited(resp, MAX_REMOTE_PAYLOAD_JSON_BYTES, signal));
  validateSyncPayloadShape(payload, cookiesOnly);
  return { ok: true, payload };
}

async function readResponseBytesLimited(resp: Response, maxBytes: number, tooLargeMessage: string, signal?: AbortSignal): Promise<Buffer> {
  const body = resp.body;
  if (!body) throw new Error("Remote response is not stream-readable");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    assertSyncNotAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) { console.error("[sync] failed to cancel oversized response reader:", e); }
      throw new Error(tooLargeMessage);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function readResponseTextLimited(resp: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  return (await readResponseBytesLimited(resp, maxBytes, "Remote config is too large", signal)).toString("utf-8");
}

function validateSyncPayloadShape(payload: any, cookiesOnly = false): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Remote config payload must be an object");
  if (payload.artifactVersion !== undefined && ![1, 2, 3, 4].includes(payload.artifactVersion)) throw new Error("Unsupported remote artifact format");
  if ([2, 3, 4].includes(payload.artifactVersion) && (typeof payload.snapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.snapshotId))) throw new Error("Remote snapshot identity is invalid");
  if (!cookiesOnly && typeof payload.data !== "string") throw new Error("Remote config payload is missing data");
  if (payload.artifactVersion === 4 && (!payload.fullProfiles || typeof payload.fullProfiles !== "object" || Array.isArray(payload.fullProfiles))) throw new Error("Complete profile inventory is required");
  if (payload.artifactVersion === 4 && ["cookies", "localStorage", "preferences", "history"].some(field => payload[field] !== undefined)) throw new Error("Complete profile snapshots must not contain plaintext legacy browser artifacts");
  if (payload.artifactVersion !== 4 && payload.fullProfiles !== undefined) throw new Error("Complete profiles require a v4 envelope");
  for (const field of ["cookies", "localStorage", "preferences", "history", "fullProfiles"]) {
    if (payload[field] !== undefined && (!payload[field] || typeof payload[field] !== "object" || Array.isArray(payload[field]))) {
      throw new Error(`Remote config ${field} must be an object`);
    }
  }
}

function parseRemoteHistory(payload: any, profiles: Record<string, any>): Record<string, HistoryCoverage> {
  if (payload.artifactVersion === 4) return {}; // History is inside the authenticated complete-profile object, not a v1 history artifact.
  if (payload.artifactVersion !== 3) {
    if (payload.history !== undefined) throw new Error("History coverage requires a v3 envelope");
    return {};
  }
  if (!payload.history || typeof payload.history !== "object" || Array.isArray(payload.history) || Object.keys(payload.history).length !== Object.keys(profiles).length) throw new Error("Remote history coverage inventory is incomplete");
  const coverage: Record<string, HistoryCoverage> = {};
  for (const [id, profile] of Object.entries(profiles)) {
    const parsed = parseHistoryCoverage(payload.history[id]);
    if (!parsed || parsed.dirId !== id || parsed.snapshotId !== payload.snapshotId || parsed.engine !== historyEngine(profile)) throw new Error("History descriptor snapshot/profile/engine mismatch");
    coverage[id] = parsed;
  }
  return coverage;
}

function validateArtifactProfileIds(payload: any, allowedProfileIds: Set<string>): void {
  for (const field of ["cookies", "localStorage", "preferences", "history", "fullProfiles"]) {
    const artifactMap = payload[field];
    if (!artifactMap || typeof artifactMap !== "object") continue;
    const ids = Object.keys(artifactMap);
    if (ids.length > MAX_SYNC_PROFILES) throw new Error(`Remote config contains too many ${field} entries`);
    for (const dirId of ids) {
      validateDirId(dirId);
      if (!allowedProfileIds.has(dirId)) throw new Error(`Remote config contains ${field} for unknown profile: ${dirId}`);
    }
  }
}

type S3Publication = { state: "accepted" | "rejected" | "unknown"; message?: string };

async function publishS3Object(sync: ReturnType<typeof getSyncConfig>, key: string, body: Buffer, signal?: AbortSignal): Promise<S3Publication> {
  assertSyncNotAborted(signal);
  const objPath = `/${sync.bucket}/${key}`;
  const headers = signS3Request({ method: "PUT", endpoint: sync.endpoint, objectPath: objPath, body, accessKey: sync.accessKey, secretKey: decryptSecretOr(sync.secretKey) });
  try {
    const response = await fetch(`${sync.endpoint}${objPath}`, { method: "PUT", headers, body: body as any, signal: combineAbortSignals(signal, 30000) });
    if (!response.ok) return { state: "rejected", message: `HTTP ${response.status}: ${await readS3ErrorDetail(response)}` };
    return { state: "accepted" };
  } catch (error) {
    // A lost response/abort after dispatch does not prove the object stayed old.
    return { state: "unknown", message: signal?.aborted ? "Upload interrupted after dispatch" : (error as Error).message };
  }
}

async function s3Put(sync: ReturnType<typeof getSyncConfig>, key: string, body: Buffer, signal?: AbortSignal): Promise<boolean> {
  const result = await publishS3Object(sync, key, body, signal);
  if (signal?.aborted) assertSyncNotAborted(signal);
  if (result.state !== "accepted") console.error(`[sync] PUT ${key}: ${result.message}`);
  return result.state === "accepted";
}

/** Fetch an object from S3 as a Buffer (for extension package pull). Returns null on 404/error. */
async function s3Get(sync: ReturnType<typeof getSyncConfig>, key: string, signal?: AbortSignal, maxBytes = MAX_EXTENSION_PACKAGE_BYTES): Promise<Buffer | null> {
  assertSyncNotAborted(signal);
  const objPath = `/${sync.bucket}/${key}`;
  const url = `${sync.endpoint}${objPath}`;
  const h = signS3Request({
    method: "GET",
    endpoint: sync.endpoint,
    objectPath: objPath,
    accessKey: sync.accessKey,
    secretKey: decryptSecretOr(sync.secretKey),
  });
  try {
    const resp = await fetch(url, { method: "GET", headers: h, signal: combineAbortSignals(signal, 60000) });
    if (!resp.ok) {
      if (resp.status !== 404) {
        const detail = await readS3ErrorDetail(resp);
        console.error(`[sync] GET ${key} failed: HTTP ${resp.status} ${detail}`);
      }
      return null;
    }
    const length = Number(resp.headers.get("content-length") || "0");
    if (length > maxBytes) throw new Error("Remote artifact object is too large");
    assertSyncNotAborted(signal);
    return await readResponseBytesLimited(resp, maxBytes, "Remote artifact object is too large", signal);
  } catch (e: any) {
    if (signal?.aborted) throw e;
    console.error(`[sync] GET ${key} error:`, e?.message || String(e));
    return null;
  }
}

function combineAbortSignals(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeout;
  if (parent.aborted) return parent;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/** Best-effort extraction of an S3 error message body for diagnostics (size-capped). */
async function readS3ErrorDetail(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    // S3 returns XML; pull <Message> if present, else truncate.
    const m = text.match(/<Message>([^<]*)<\/Message>/i);
    if (m) return m[1];
    return text.slice(0, 200);
  } catch { return ""; }
}

// ── AWS Signature V4 (replaces the deprecated V2 path) ──────────────────────
// Required by AWS S3 (V2 removed 2019), MinIO, and most S3-compatible stores.
// MinIO uses path-style addressing and region "us-east-1" by default.
const S3_REGION = "us-east-1";
const S3_SERVICE = "s3";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function uriEncodePath(path: string): string {
  // Encode each segment but keep "/". S3 expects unencoded "/" between segments.
  return path.split("/").map((seg) => encodeURIComponent(seg).replace(/'/g, "%27")).join("/");
}

function uriEncodeQuery(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build AWS Signature Version 4 headers for an S3-compatible PUT/GET.
 * Uses path-style addressing (<endpoint>/<bucket>/<key>) which MinIO expects.
 */
export function signS3Request(opts: {
  method: string;
  endpoint: string;
  objectPath: string; // e.g. "/my-bucket/path/to/key"
  body?: Buffer | null;
  accessKey: string;
  secretKey: string;
  contentType?: string;
}): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = opts.body ? sha256Hex(opts.body) : "UNSIGNED-PAYLOAD";
  const contentType = opts.contentType ?? (opts.body ? "application/octet-stream" : "");

  // Canonical URI: encode path segments, keep leading slash structure.
  const canonicalUri = uriEncodePath(opts.objectPath) || "/";

  // Headers we sign (lowercased names, sorted). Host derived from endpoint.
  let host = opts.endpoint;
  try { host = new URL(opts.endpoint).host; } catch { /* keep raw */ }
  const headerMap: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headerMap["content-type"] = contentType;

  const signedHeaderNames = Object.keys(headerMap).sort();
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${headerMap[n].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    "", // canonical query string (none for these calls)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${opts.secretKey}`, dateStamp),
        S3_REGION,
      ),
      S3_SERVICE,
    ),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const headers: Record<string, string> = { ...headerMap };
  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// Legacy V2 signer kept for backward-compat reference but no longer used by PUT/GET.
// (MinIO and AWS S3 both reject V2.)
export function signV2(opts: { method: string; objectPath?: string; body?: Buffer; accessKey: string; secretKey: string }): Record<string, string> {
  const date = new Date().toUTCString();
  const ct = opts.body ? "application/json" : "";
  const md5 = opts.body ? createHash("md5").update(opts.body).digest("base64") : "";
  const stringToSign = `${opts.method}\n${md5}\n${ct}\n${date}\n${opts.objectPath}`;
  const sig = createHmac("sha1", opts.secretKey).update(stringToSign).digest("base64");
  const headers: Record<string, string> = { "Date": date, "Authorization": `AWS ${opts.accessKey}:${sig}` };
  if (ct) headers["Content-Type"] = ct;
  if (md5) headers["Content-MD5"] = md5;
  return headers;
}

function listExtensionsForSync(dirId: string): Array<{ id: string; name: string; version: string }> {
  const root = resolveProfileFile(dirId, "Default", "Extensions");
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe extension inventory directory");
  const inventory: Array<{ id: string; name: string; version: string }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-p]{32}$/.test(entry.name)) continue;
    if (inventory.length >= 500) throw new Error("Profile extension inventory is too large");
    const directory = path.join(root, entry.name);
    const versions = fs.readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
    for (const candidate of [directory, ...versions.map((version) => path.join(directory, version.name))]) {
      const file = path.join(candidate, "manifest.json");
      const before = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!before) continue;
      if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) throw new Error("Unsafe extension inventory manifest");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let raw: Buffer;
      try {
        const opened = fs.fstatSync(fd);
        raw = fs.readFileSync(fd);
        const after = fs.lstatSync(file);
        if (opened.dev !== before.dev || opened.ino !== before.ino || raw.length !== before.size || after.isSymbolicLink() ||
            after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Extension inventory changed during capture");
      } finally { fs.closeSync(fd); }
      const manifest = JSON.parse(raw.toString("utf8"));
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || manifest.name.length > 512 || manifest.version.length > 128) throw new Error("Invalid extension inventory manifest");
      // Metadata only: do not read icons, locale paths, or extension code.
      inventory.push({ id: entry.name, name: manifest.name, version: manifest.version });
      break;
    }
  }
  return inventory;
}

function cloneConfig(config: MgmtConfig): MgmtConfig {
  return JSON.parse(JSON.stringify(config));
}

function sanitizeConfigForSync(config: MgmtConfig): SyncSafeConfig {
  return serializeSyncSafeConfig(config);
}

function sanitizeExtensionRepoEntry(extId: string, entry: any): any | null {
  if (!EXTENSION_HASH_RE.test(String(entry?.packageHash || ""))) return null;
  if (!EXTENSION_HASH_RE.test(String(entry?.manifestHash || ""))) return null;
  return {
    id: typeof entry?.id === "string" ? entry.id : extId,
    name: entry?.name,
    version: entry?.version,
    description: entry?.description,
    source: entry?.source,
    chromeStoreUrl: entry?.chromeStoreUrl || null,
    ...(typeof entry?.updateUrl === "string" ? { updateUrl: entry.updateUrl } : {}),
    packageHash: entry.packageHash,
    manifestHash: entry.manifestHash,
    shared: entry?.shared,
    tags: Array.isArray(entry?.tags) ? entry.tags : [],
    addedAt: entry?.addedAt,
    updatedAt: entry?.updatedAt,
  };
}

function sanitizeRemoteConfig(config: MgmtConfig): MgmtConfig {
  const safe = serializeSyncSafeConfig(config) as any;
  delete safe.sync;
  for (const [id, raw] of Object.entries((config as any).browserProfiles ?? (config as any).cloakProfiles ?? {}) as Array<[string, any]>) {
    for (const field of PORTABLE_PROFILE_FIELDS) {
      if (!Object.hasOwn(raw, field)) delete safe.browserProfiles[id][field];
    }
  }
  // Preserve remote extension repository metadata needed for package restore, but
  // strip local absolute paths from older sync artifacts.
  const remoteExts = (config as any).extensionRepository;
  if (remoteExts && typeof remoteExts === "object") {
    safe.extensionRepository = {};
    for (const [extId, entry] of Object.entries(remoteExts) as Array<[string, any]>) {
      if (!/^(?:[a-p]{32}|local_[a-z0-9]{8,40})$/.test(extId)) continue;
      const safeEntry = sanitizeExtensionRepoEntry(extId, entry);
      if (!safeEntry) continue;
      safe.extensionRepository[extId] = safeEntry;
    }
  }
  return safe as MgmtConfig;
}

function serializeSyncSafeConfig(config: MgmtConfig): SyncSafeConfig {
  const cfg = config as any;
  const profiles: Record<string, any> = {};
  const sourceProfiles = cfg.browserProfiles ?? cfg.cloakProfiles ?? {};
  for (const [dirId, profile] of Object.entries(sourceProfiles) as Array<[string, any]>) {
    validateDirId(dirId);
    if (["__proto__", "prototype", "constructor"].includes(dirId)) throw new Error("Reserved profile ID is not portable");
    profiles[dirId] = {
      ...portableProfileContent(profile),
      fontsDir: null,
      ...(profile.lock && typeof profile.lock === "object" && profile.lock.owner
        ? { lock: { owner: String(profile.lock.owner).slice(0, 64), ownerName: String(profile.lock.ownerName || "").slice(0, 64), at: Number.isFinite(profile.lock.at) ? profile.lock.at : 0 } }
        : {}),
      updatedAt: Number.isFinite(profile.updatedAt) ? profile.updatedAt : undefined,
      syncedAt: profile.syncedAt,
      syncedHash: profile.syncedHash,
      syncBaseline: parseProfileSyncBaseline(profile.syncBaseline) || undefined,
    };
  }

  const proxies: Record<string, Omit<ProxyConfig, "password">> = {};
  for (const [name, proxy] of Object.entries(cfg.proxies || {}) as Array<[string, any]>) {
    proxies[name] = {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      ...(Number.isFinite(proxy.updatedAt) ? { updatedAt: proxy.updatedAt } : {}),
      ...(Array.isArray(proxy.bypassList) ? { bypassList: proxy.bypassList } : {}),
    };
  }

  // Extension repository metadata (package files synced separately per-key).
  // Omit unpackedPath so sync artifacts do not reveal local filesystem paths.
  const extensionRepo: Record<string, any> = {};
  const sourceExtensionRepo = cfg.extensionRepository && typeof cfg.extensionRepository === "object"
    ? Object.values(cfg.extensionRepository) as any[]
    : listExtensionRepository();
  for (const entry of sourceExtensionRepo) {
    const safeEntry = sanitizeExtensionRepoEntry(entry.id, entry);
    if (safeEntry) extensionRepo[entry.id] = safeEntry;
  }

  const accounts = Array.isArray(cfg.accounts)
    ? (cfg.accounts as any[]).map((acc) => ({
        platformUrl: String(acc?.platformUrl || ""),
        platformUserName: String(acc?.platformUserName || ""),
        profileIds: Array.isArray(acc?.profileIds) ? (acc.profileIds as any[]).map(String) : [],
        tags: Array.isArray(acc?.tags) ? (acc.tags as any[]).map(String) : [],
        createdAt: Number.isFinite(acc?.createdAt) ? acc.createdAt : undefined,
        updatedAt: Number.isFinite(acc?.updatedAt) ? acc.updatedAt : undefined,
      })).filter((a) => a.platformUrl && a.platformUserName)
    : [];

  return {
    version: Math.max(4, Number(cfg.version) || 0),
    chromiumBin: "auto",
    defaultProxy: cfg.defaultProxy || "default",
    proxies,
    sync: {
      enabled: Boolean(cfg.sync?.enabled),
      endpoint: cfg.sync?.endpoint || "",
      bucket: cfg.sync?.bucket || "",
    },
    browserProfiles: profiles,
    extensionRepository: extensionRepo,
    accounts,
    team: sanitizeTeam((config as any).team),
  } as SyncSafeConfig;
}

function markAllProfilesSynced(config: MgmtConfig | SyncSafeConfig, timestamp: number, artifacts: { profilePreferences: Record<string, ProfilePreferencesSnapshot>; targetId: string; snapshotId: string }): void {
  for (const [dirId, profile] of Object.entries(config.browserProfiles || {})) {
    const preferences = artifacts.profilePreferences[dirId];
    if (!preferences) throw new Error(`Missing Preferences capture evidence for ${dirId}`);
    const baseline = createProfileSyncBaseline(profile, preferences, artifacts.targetId, artifacts.snapshotId, timestamp);
    profile.syncedAt = timestamp;
    profile.syncedHash = baseline.contentHash;
    profile.syncBaseline = baseline;
  }
}

function compareProfilePreferences(section: SyncDiffSection, localProfiles: Record<string, any>, remoteProfiles: Record<string, any>, payload: any): NonNullable<SyncDiffResult["coverage"]> {
  const unverified: Array<{ id: string; reason: string }> = [];
  for (const id of Object.keys(localProfiles)) {
    if (!Object.hasOwn(remoteProfiles, id)) continue;
    try {
      const baseline = parseProfileSyncBaseline(remoteProfiles[id].syncBaseline);
      if (([2, 3].includes(payload.artifactVersion) && (!baseline || baseline.snapshotId !== payload.snapshotId)) ||
          (remoteProfiles[id].syncBaseline !== undefined && !baseline)) {
        unverified.push({ id, reason: "remote-baseline-mismatch" });
        continue;
      }
      let remoteEvidence: ProfilePreferencesSnapshot;
      if (Object.hasOwn(payload.preferences || {}, id)) {
        const raw = gunzipBase64Field(payload.preferences[id], MAX_PREFERENCES_GZIP_BYTES, MAX_PREFERENCES_JSON_BYTES, "preferences");
        validatePreferencesJson(raw);
        remoteEvidence = profilePreferencesSnapshot(raw);
      } else if (baseline?.preferences.state === "absent") remoteEvidence = profilePreferencesSnapshot(null);
      else { unverified.push({ id, reason: "remote-preferences-not-covered" }); continue; }
      if (baseline && (stableStringify(baseline.preferences) !== stableStringify(remoteEvidence) ||
          profileContentHash(remoteProfiles[id], remoteEvidence) !== baseline.contentHash)) {
        unverified.push({ id, reason: "remote-baseline-mismatch" });
        continue;
      }
      const localEvidence = profilePreferencesSnapshot(capturePreferences(id, false));
      if (stableStringify(localEvidence) === stableStringify(remoteEvidence)) continue;
      const existing = section.changed.find((item) => item.id === id);
      if (existing) existing.fields = [...new Set([...existing.fields, "preferences"])].sort();
      else section.changed.push({ id, fields: ["preferences"] });
    } catch { unverified.push({ id, reason: "preferences-unavailable" }); }
  }
  section.changed.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { compared: ["portable-profile-metadata", "preferences-on-common-profiles", "proxy-settings", "account-references", "extension-metadata"],
    notCompared: ["live-cookies", "localStorage-database", "history-database", "full-profile-files"], unverified };
}

function createComparisonToken(sync: SyncConfig, local: any, payload: any): SyncComparisonToken {
  const preferences: Record<string, ProfilePreferencesSnapshot> = {};
  for (const id of Object.keys(local.browserProfiles || {})) preferences[id] = profilePreferencesSnapshot(capturePreferences(id, false));
  return {
    targetId: getProfileSyncTarget(sync),
    localHash: sha256Hex(stableStringify({ profiles: profileDecisionMap(local.browserProfiles || {}), preferences,
      proxies: local.proxies, accounts: local.accounts, extensions: local.extensionRepository, defaultProxy: local.defaultProxy, team: local.team })),
    remoteHash: sha256Hex(stableStringify(payload)),
  };
}

function assertComparisonUnchanged(token: SyncComparisonToken | undefined, sync: SyncConfig, payload: any): void {
  if (token === undefined) return; // Direct API/automation intent has no prior UI decision.
  const stale = (cause?: unknown) => Object.assign(new Error("Comparison is stale or cannot be verified; compare again before applying decisions", { cause }), { code: "SYNC_PREVIEW_STALE" });
  if (!token || typeof token !== "object" || Array.isArray(token) ||
      ![token.targetId, token.localHash, token.remoteHash].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) throw stale();
  let current: SyncComparisonToken;
  try { current = createComparisonToken(sync, sanitizeConfigForSync(cloneConfig(getConfig())), payload); }
  catch (error) { throw stale(error); }
  if (token.targetId !== current.targetId || token.localHash !== current.localHash || token.remoteHash !== current.remoteHash) throw stale();
}

function profileDecisionMap(profiles: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, {
    ...portableProfileContent(profile),
    updatedAt: profile.updatedAt,
    ...(profile.lock ? { lock: profile.lock } : {}),
  }]));
}

function getSyncProfileName(config: MgmtConfig | SyncSafeConfig, dirId: string): string {
  const cfg = config as any;
  return cfg.browserProfiles?.[dirId]?.name || dirId.slice(0, 8);
}

function markRemoteProfilesSynced(merged: MgmtConfig, remoteConfig: MgmtConfig, timestamp: number, artifacts: { selectedRemoteProfiles: Set<string>; preferences: Set<string>; preferenceHashes: Record<string, string>; targetId: string }): void {
  for (const dirId of artifacts.selectedRemoteProfiles) {
    const remote = remoteConfig.browserProfiles?.[dirId];
    const current = merged.browserProfiles?.[dirId];
    if (!remote || !current) continue;
    const baseline = parseProfileSyncBaseline(remote.syncBaseline);
    delete current.syncBaseline;
    delete current.syncedHash;
    current.syncedAt = timestamp;
    if (!baseline) continue; // legacy data was adopted, not upgraded by guessing
    let evidence: ProfilePreferencesSnapshot | undefined;
    if (artifacts.preferences.has(dirId)) evidence = profilePreferencesSnapshot(Buffer.from(artifacts.preferenceHashes[dirId], "base64"));
    else if (baseline.preferences.state === "absent") {
      try { if (capturePreferences(dirId) === null) evidence = profilePreferencesSnapshot(null); }
      catch (error) { console.warn(`[sync] adopted profile baseline remains unverified for ${dirId}:`, (error as Error).message); }
    }
    if (!evidence || profileContentHash(remote, evidence) !== baseline.contentHash || profileContentHash(current, evidence) !== baseline.contentHash) continue;
    current.syncBaseline = createProfileSyncBaseline(current, evidence, artifacts.targetId, baseline.snapshotId, timestamp);
    current.syncedHash = current.syncBaseline.contentHash;
  }
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = Object.create(null);
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function getHostname(): string { try { return os.hostname(); } catch { return "unknown"; } }
export interface SyncDiffSection {
  localOnly: string[];
  remoteOnly: string[];
  changed: Array<{ id: string; fields: string[] }>;
}

export interface SyncDiffResult {
  ok: boolean;
  comparisonToken?: SyncComparisonToken;
  coverage?: { compared: string[]; notCompared: string[]; unverified: Array<{ id: string; reason: string }> };
  message?: string;
  remoteTimestamp?: number | null;
  firstPush?: boolean;
  profiles: SyncDiffSection;
  proxies: SyncDiffSection;
  accounts: SyncDiffSection;
  extensions: SyncDiffSection;
  defaultProxy: { local: string | null; remote: string | null };
  artifacts: { cookies: string[]; localStorage: string[]; preferences: string[] };
  remoteLocks: Array<{ id: string; ownerName: string }>;
  pushWarnings: string[];
  pullNotes: string[];
}

const SYNC_BOOKKEEPING_FIELDS = new Set(["syncedAt", "syncedHash", "syncBaseline", "updatedAt"]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

function changedTopFields(a: any, b: any, ignore: Set<string>): string[] {
  const keys = new Set<string>([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out: string[] = [];
  for (const k of keys) {
    if (ignore.has(k)) continue;
    if (stableStringify(a?.[k]) !== stableStringify(b?.[k])) out.push(k);
  }
  return out.sort();
}

function diffSectionById(localMap: Record<string, any>, remoteMap: Record<string, any>): SyncDiffSection {
  const localIds = Object.keys(localMap || {});
  const remoteIds = Object.keys(remoteMap || {});
  const localSet = new Set(localIds);
  const remoteSet = new Set(remoteIds);
  const localOnly = localIds.filter((id) => !remoteSet.has(id)).sort();
  const remoteOnly = remoteIds.filter((id) => !localSet.has(id)).sort();
  const changed: Array<{ id: string; fields: string[] }> = [];
  for (const id of localIds) {
    if (!remoteSet.has(id)) continue;
    const fields = changedTopFields(localMap[id], remoteMap[id], SYNC_BOOKKEEPING_FIELDS);
    if (fields.length) changed.push({ id, fields });
  }
  changed.sort((a, b) => a.id.localeCompare(b.id));
  return { localOnly, remoteOnly, changed };
}

function diffAccountArrays(local: any[], remote: any[]): SyncDiffSection {
  const keyOf = (a: any): [string, string] => [String(a?.platformUserName || ""), String(a?.platformUrl || "")];
  const localMap: Record<string, any> = {};
  const remoteMap: Record<string, any> = {};
  for (const a of local || []) {
    const [u, url] = keyOf(a);
    if (u && url) localMap[u + "\u0000" + url] = a;
  }
  for (const a of remote || []) {
    const [u, url] = keyOf(a);
    if (u && url) remoteMap[u + "\u0000" + url] = a;
  }
  const raw = diffSectionById(localMap, remoteMap);
  const pretty = (k: string) => k.split("\u0000").join(" @ ");
  return {
    localOnly: raw.localOnly.map(pretty),
    remoteOnly: raw.remoteOnly.map(pretty),
    changed: raw.changed.map((c) => ({ id: pretty(c.id), fields: c.fields })),
  };
}

type MergeStrategy = "local" | "remote" | "newest";

function normalizeMergeStrategy(value: unknown): MergeStrategy {
  return value === "remote" || value === "newest" ? value : "local";
}

export interface SyncPullOptions extends SyncHistoryOptions {
  /** Explicit legacy partial-live merge. Default skips the entire active/unconfirmed profile. */
  allowRunningPartial?: boolean;
  strategy?: MergeStrategy;
  comparisonToken?: SyncComparisonToken;
  /** Per-entry overrides keyed as "<section>:<id>", e.g. "profiles:ab_xyz" or "accounts:user @ https://a.com". */
  resolutions?: Record<string, MergeStrategy>;
}

// Per-entry conflict resolution: an explicit override wins, otherwise null
// (caller falls back to the global strategy).
function resolutionFor(
  resolutions: Record<string, MergeStrategy> | undefined,
  section: string,
  id: string,
): MergeStrategy | null {
  const value = resolutions?.[section + ":" + id];
  return value === "local" || value === "remote" || value === "newest" ? value : null;
}

function entryUpdatedAt(entry: any): number {
  const ts = Number(entry?.updatedAt ?? entry?.syncedAt ?? 0);
  return Number.isFinite(ts) ? ts : 0;
}

function remoteWins(localEntry: any, remoteEntry: any, strategy: MergeStrategy): boolean {
  return strategy === "remote" || (strategy === "newest" && entryUpdatedAt(remoteEntry) > entryUpdatedAt(localEntry));
}

// Artifact selection must not use the merged object's identity: the metadata
// merge deliberately keeps the local instance for equal metadata even when the
// remote browser files differ. Remote-only entries are always imported.
function selectRemoteEntries(
  localMap: Record<string, any>,
  remoteMap: Record<string, any>,
  strategy: MergeStrategy,
  resolutionFor?: (id: string) => MergeStrategy | null,
): Set<string> {
  const selected = new Set<string>();
  for (const [id, remoteEntry] of Object.entries(remoteMap || {})) {
    if (!Object.hasOwn(localMap, id) || remoteWins(localMap[id], remoteEntry, resolutionFor?.(id) ?? strategy)) {
      selected.add(id);
    }
  }
  return selected;
}

function assertSelectedProfileUnchanged(snapshot: Record<string, any>, current: Record<string, any>, id: string): void {
  if (Object.hasOwn(snapshot, id) !== Object.hasOwn(current, id)
    || (Object.hasOwn(snapshot, id) && stableStringify(snapshot[id]) !== stableStringify(current[id]))) {
    throw new Error(`Profile changed during sync pull: ${id}`);
  }
}

// Merge an id-keyed section (profiles / proxies / extensions) by strategy.
//   local  → keep the local entry on conflicts (legacy behaviour)
//   remote → adopt the remote entry on conflicts
//   newest → adopt whichever side is newer (updatedAt, falling back to syncedAt)
// Entries that exist on only one side are always adopted from that side.
function mergeSectionById(
  localMap: Record<string, any>,
  remoteMap: Record<string, any>,
  strategy: MergeStrategy,
  resolutionFor?: (id: string) => MergeStrategy | null,
  localOnly?: { ignoredFields: Set<string>; onRemoteWin: (local: any, remote: any) => any },
): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const [id, entry] of Object.entries(localMap || {})) merged[id] = entry;
  for (const [id, remoteEntry] of Object.entries(remoteMap || {})) {
    if (!Object.hasOwn(merged, id)) {
      merged[id] = remoteEntry;
      continue;
    }
    const localEntry = merged[id];
    if (changedTopFields(localEntry, remoteEntry, localOnly?.ignoredFields ?? SYNC_BOOKKEEPING_FIELDS).length === 0) continue;
    const effective = resolutionFor ? (resolutionFor(id) ?? strategy) : strategy;
    if (remoteWins(localEntry, remoteEntry, effective)) {
      merged[id] = localOnly ? localOnly.onRemoteWin(localEntry, remoteEntry) : remoteEntry;
    }
  }
  return merged;
}

// Only these fields are intentionally absent from sync snapshots. Keep them
// from the live commit-time draft, never from the untrusted remote payload.
const PROXY_SYNC_IGNORED_FIELDS = new Set([...SYNC_BOOKKEEPING_FIELDS, "username", "password"]);
const ACCOUNT_SYNC_IGNORED_FIELDS = new Set([...SYNC_BOOKKEEPING_FIELDS, "platformPassword"]);

function mergeProxySection(
  local: Record<string, ProxyConfig>,
  remote: Record<string, ProxyConfig>,
  strategy: MergeStrategy,
  resolutionFor?: (id: string) => MergeStrategy | null,
): Record<string, ProxyConfig> {
  return mergeSectionById(local, remote, strategy, resolutionFor, {
    ignoredFields: PROXY_SYNC_IGNORED_FIELDS,
    onRemoteWin: (previous: ProxyConfig, incoming: ProxyConfig): ProxyConfig => {
      // A proxy name alone does not identify the authentication target. A new
      // protocol, host or port needs fresh credentials, not the old endpoint's.
      if (previous.type !== incoming.type || previous.host !== incoming.host || previous.port !== incoming.port) return incoming;
      return {
        ...incoming,
        ...(typeof previous.username === "string" ? { username: previous.username } : {}),
        ...(typeof previous.password === "string" ? { password: previous.password } : {}),
      };
    },
  });
}

function accountMapOf(accounts: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const acc of accounts || []) {
    const u = String(acc?.platformUserName || "");
    const url = String(acc?.platformUrl || "");
    if (u && url) out[u + "\u0000" + url] = acc;
  }
  return out;
}

// Merge the accounts array (keyed by platformUserName + platformUrl) by strategy.
function mergeAccountSection(
  remote: any[],
  local: any[],
  strategy: MergeStrategy,
  resolutionFor?: (id: string) => MergeStrategy | null,
): any[] {
  return Object.values(mergeSectionById(accountMapOf(local), accountMapOf(remote), strategy, resolutionFor, {
    ignoredFields: ACCOUNT_SYNC_IGNORED_FIELDS,
    onRemoteWin: (previous: any, incoming: any) => ({
      ...incoming,
      // The map key is the full username + URL identity. Never match another
      // account by array position, profile binding, or just its username.
      ...(typeof previous.platformPassword === "string" ? { platformPassword: previous.platformPassword } : {}),
    }),
  }));
}

// Count conflicting entries (present on both sides, differing) that ended up
// adopting the remote version. Remote-only entries are not conflicts.
function countAdoptedFromRemote(
  localMap: Record<string, any>,
  mergedMap: Record<string, any>,
  strategy: MergeStrategy,
  resolutionFor?: (id: string) => MergeStrategy | null,
): number {
  let count = 0;
  for (const [id, entry] of Object.entries(mergedMap || {})) {
    if (!(id in (localMap || {}))) continue;
    const effective = resolutionFor ? (resolutionFor(id) ?? strategy) : strategy;
    if (effective === "local") continue;
    if (entry !== (localMap as any)[id]) count++;
  }
  return count;
}

function mergeAccountArrays(remote: any[], local: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const acc of local || []) {
    const u = String(acc?.platformUserName || "");
    const url = String(acc?.platformUrl || "");
    if (!u || !url) continue;
    const key = u + "\u0000" + url;
    seen.add(key);
    out.push(acc);
  }
  for (const acc of remote || []) {
    const u = String(acc?.platformUserName || "");
    const url = String(acc?.platformUrl || "");
    if (!u || !url) continue;
    const key = u + "\u0000" + url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(acc);
  }
  return out;
}

function emptySyncDiff(): Omit<SyncDiffResult, "ok" | "message"> {
  return {
    firstPush: false,
    profiles: { localOnly: [], remoteOnly: [], changed: [] },
    proxies: { localOnly: [], remoteOnly: [], changed: [] },
    accounts: { localOnly: [], remoteOnly: [], changed: [] },
    extensions: { localOnly: [], remoteOnly: [], changed: [] },
    defaultProxy: { local: null, remote: null },
    artifacts: { cookies: [], localStorage: [], preferences: [] },
    remoteLocks: [],
    pushWarnings: [],
    pullNotes: [],
  };
}

function buildSyncDiff(local: any, remote: any, payload: any, myDeviceId?: string): Omit<SyncDiffResult, "ok" | "message" | "remoteTimestamp"> {
  const profiles = diffSectionById(local?.browserProfiles || {}, remote?.browserProfiles || {});
  const proxies = diffSectionById(local?.proxies || {}, remote?.proxies || {});
  const extensions = diffSectionById(local?.extensionRepository || {}, remote?.extensionRepository || {});
  const accounts = diffAccountArrays(local?.accounts || [], remote?.accounts || []);

  const remoteLocks: Array<{ id: string; ownerName: string }> = [];
  for (const [id, p] of Object.entries(remote?.browserProfiles || {}) as Array<[string, any]>) {
    const lock = p?.lock;
    if (lock && typeof lock.owner === "string" && lock.owner && (!myDeviceId || lock.owner !== myDeviceId)) {
      remoteLocks.push({ id, ownerName: String(lock.ownerName || lock.owner) });
    }
  }
  remoteLocks.sort((a, b) => a.id.localeCompare(b.id));

  // R146: these notes are rendered verbatim in the sync diff panel, so they were
  // the last large block of Chinese copy reaching the English UI. They go
  // through tMain with {n} / {ids} placeholders rather than string
  // concatenation, because the clause order differs between the two languages
  // and a translator cannot fix that by editing fragments.
  const pushWarnings: string[] = [];
  const pullNotes: string[] = [];
  const idsOf = (list: string[]) =>
    list.slice(0, 8).join(", ") + (list.length > 8 ? " (+" + (list.length - 8) + ")" : "");
  if (remoteLocks.length) {
    const owners = remoteLocks.map((l) => l.ownerName).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(", ");
    pushWarnings.push(
      tMain("sync.warn.remote-locks", "{n} profile(s) are locked by another device; push will be rejected unless forced: {ids} ({owners})")
        .replace("{n}", String(remoteLocks.length))
        .replace("{ids}", remoteLocks.map((l) => l.id).slice(0, 8).join(", "))
        .replace("{owners}", owners),
    );
  }
  if (profiles.remoteOnly.length) {
    pushWarnings.push(
      tMain("sync.warn.push-removes-profiles", "Push will remove {n} remote-only profile(s) from the remote: {ids}")
        .replace("{n}", String(profiles.remoteOnly.length))
        .replace("{ids}", idsOf(profiles.remoteOnly)),
    );
  }
  if (proxies.remoteOnly.length) {
    pushWarnings.push(
      tMain("sync.warn.push-removes-proxies", "Push will remove {n} remote-only proxy/proxies from the remote: {ids}")
        .replace("{n}", String(proxies.remoteOnly.length))
        .replace("{ids}", idsOf(proxies.remoteOnly)),
    );
  }
  if (extensions.remoteOnly.length) {
    pushWarnings.push(
      tMain("sync.warn.push-removes-extensions", "Push will remove {n} remote-only extension(s) from the remote")
        .replace("{n}", String(extensions.remoteOnly.length)),
    );
  }
  if (accounts.remoteOnly.length) {
    pushWarnings.push(
      tMain("sync.warn.push-removes-accounts", "Push will remove {n} remote-only account(s) from the remote")
        .replace("{n}", String(accounts.remoteOnly.length)),
    );
  }
  if (profiles.remoteOnly.length) {
    pullNotes.push(
      tMain("sync.note.pull-imports-profiles", "Pull will import {n} remote-only profile(s): {ids}")
        .replace("{n}", String(profiles.remoteOnly.length))
        .replace("{ids}", idsOf(profiles.remoteOnly)),
    );
  }
  if (proxies.remoteOnly.length) {
    pullNotes.push(
      tMain("sync.note.pull-imports-proxies", "Pull will import {n} remote-only proxy/proxies")
        .replace("{n}", String(proxies.remoteOnly.length)),
    );
  }
  if (profiles.changed.length) {
    pullNotes.push(
      tMain("sync.note.pull-overwrites-conflicts", "Pull will overwrite conflicting fields on {n} profile(s) present on both sides (local-first does not replace the whole profile)")
        .replace("{n}", String(profiles.changed.length)),
    );
  }

  return {
    profiles,
    proxies,
    accounts,
    extensions,
    defaultProxy: { local: local?.defaultProxy || null, remote: remote?.defaultProxy || null },
    artifacts: {
      cookies: Object.keys(payload?.cookies || {}).sort(),
      localStorage: Object.keys(payload?.localStorage || {}).sort(),
      preferences: Object.keys(payload?.preferences || {}).sort(),
    },
    remoteLocks,
    pushWarnings,
    pullNotes,
  };
}

function maskKey(k: string): string { return k?.length >= 8 ? k.slice(0, 4) + "****" + k.slice(-4) : k || ""; }

async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | null> {
  assertSyncNotAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let cleanupAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<null>((resolve, reject) => {
        timer = setTimeout(() => resolve(null), ms);
        const onAbort = () => reject(new Error("Sync operation cancelled"));
        cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    return result;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    cleanupAbort?.();
  }
}

export const __syncTestHooks = {
  decodeBase64Field,
  extractSafeLocalStorageArchive,
  fetchRemoteCookiesForPush,
  readResponseBytesLimited,
  isProfileRunningForRestore,
  validateArtifactProfileIds,
  serializeSyncSafeConfig,
  sanitizeRemoteConfig,
  validatePreferencesJson,
  buildSyncDiff,
  stableStringify,
  mergeAccountArrays,
  mergeSectionById,
  mergeProxySection,
  mergeAccountSection,
  countAdoptedFromRemote,
  normalizeMergeStrategy,
  collectRemoteLocksBlockingPush,
};
