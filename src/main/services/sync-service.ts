import { createHash, createHmac } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { spawn } from "node:child_process";
import { getSyncConfig, getConfig, saveConfig, getProfilesDir } from "./config-manager.js";
import { cdpCookieService } from "./cdp-cookie-service.js";
import { listExtensions } from "./launch-args.js";
import { acquireRestoreLock, isRestoreLocked } from "./profile-restore-lock.js";
import { decryptSecretOr } from "./secrets.js";
import { statusCloak } from "./cloak-manager.js";
import { validateDirId } from "./utils.js";
import { listExtensionRepository, getExtensionRepoEntryDir, restoreSyncedExtensionPackage } from "./extension-repository.js";
import type { SyncConfig, MgmtConfig, CookieInfo, ProxyConfig } from "../types.js";

export interface SyncResult {
  success: boolean;
  message: string;
  transferredBytes?: number;
}

type SyncSafeConfig = Omit<MgmtConfig, "sync" | "proxies"> & {
  sync: Omit<SyncConfig, "accessKey" | "secretKey">;
  proxies: Record<string, Omit<ProxyConfig, "username" | "password">>;
};

const SYNC_CONFIG_KEY = "cloak-lite-config.json";
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

export const syncService = {
  // ── Preview (offline pre-flight: what a push would involve + who'd skip on pull) ──
  preview(): { configured: boolean; profiles: number; runningProfiles: string[]; proxies: number; accounts: number; extensions: number; message: string } {
    const cfg = getConfig() as any;
    const sync = getSyncConfig();
    const profileIds = Object.keys(cfg.cloakProfiles || {});
    const runningProfiles: string[] = [];
    for (const dirId of profileIds) {
      try { if (statusCloak(dirId).running) runningProfiles.push(dirId); } catch { /* ignore */ }
    }
    let extensions = 0;
    try { extensions = listExtensionRepository().length; } catch { /* ignore */ }
    const configured = Boolean(sync.enabled && sync.endpoint && sync.bucket);
    const skipNote = runningProfiles.length
      ? `（${runningProfiles.length} 个运行中,pull 时跳过 localStorage/preferences）`
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
  // ── Push ──
  async push(signal?: AbortSignal): Promise<SyncResult> {
    assertSyncNotAborted(signal);
    const sync = getSyncConfig();
    if (!sync.enabled || !sync.endpoint || !sync.bucket) {
      return { success: false, message: "Sync not enabled or configured" };
    }

    try {
      const now = Date.now();
      const latestConfig = getConfig();
      const syncSnapshot = sanitizeConfigForSync(cloneConfig(latestConfig));
      assertSyncNotAborted(signal);

      // Fetch cookies previously stored remotely to prevent overwrites for offline profiles.
      const remoteCookies = await fetchRemoteCookiesForPush(sync, signal);
      assertSyncNotAborted(signal);

      const cookiesBlob: Record<string, string> = {};
      const localStorageBlobs: Record<string, string> = {};
      const prefsBlobs: Record<string, string> = {};
      const cloakPreferenceHashes: Record<string, string> = {};
      let totalCookies = 0, totalLs = 0, totalPrefs = 0;

      const cloakDirIds = Object.keys(syncSnapshot.cloakProfiles || {});
      console.log(`[sync] push: exporting ${cloakDirIds.length} Cloak profiles`);

      for (const dirId of cloakDirIds) {
        assertSyncNotAborted(signal);
        validateDirId(dirId);
        // Preferences
        const prefsPath = path.join(getProfilesDir(), dirId, "Default", "Preferences");
        if (fs.existsSync(prefsPath)) {
          const rawPrefs = fs.readFileSync(prefsPath);
          cloakPreferenceHashes[dirId] = rawPrefs.toString("base64");
          prefsBlobs[dirId] = zlib.gzipSync(rawPrefs).toString("base64");
          totalPrefs++;
        }

        // Cookies (CDP)
        const cookieList = await withTimeout(cdpCookieService.exportCookies(dirId, signal), 5000, signal);
        assertSyncNotAborted(signal);
        if (cookieList && cookieList.length > 0) {
          cookiesBlob[dirId] = zlib.gzipSync(JSON.stringify(cookieList)).toString("base64");
          totalCookies += cookieList.length;
        } else if (remoteCookies[dirId] && isValidCookieBlob(remoteCookies[dirId])) {
          cookiesBlob[dirId] = remoteCookies[dirId];
        }

        // LocalStorage (LevelDB)
        const lsTar = await exportLocalStorage(dirId, signal);
        if (lsTar) {
          localStorageBlobs[dirId] = lsTar.toString("base64");
          totalLs++;
        }

        // Extensions list
        const extDir = path.join(getProfilesDir(), dirId, "Default", "Extensions");
        if (fs.existsSync(extDir)) {
          try {
            const extSnap = listExtensionsForSync(dirId);
            if (extSnap && extSnap.length > 0) {
              const extPayload = { dirId, profileName: getSyncProfileName(syncSnapshot, dirId), timestamp: now, extensions: extSnap };
              await s3Put(sync, `extensions-${dirId}.json`, Buffer.from(JSON.stringify(extPayload)), signal);
            }
          } catch (e) {
            if (signal?.aborted) throw e;
            console.error(`[sync] failed to snapshot extensions for ${dirId}:`, e);
          }
        }
      }

      markAllProfilesSynced(syncSnapshot, now, { cloakPreferences: cloakPreferenceHashes });

      const configPayload = JSON.stringify({
        version: syncSnapshot.version, timestamp: now,
        data: zlib.gzipSync(JSON.stringify(syncSnapshot, null, 2)).toString("base64"),
        cookies: cookiesBlob,
        localStorage: localStorageBlobs,
        preferences: prefsBlobs,
      });

      assertSyncNotAborted(signal);
      const ok = await s3Put(sync, SYNC_CONFIG_KEY, Buffer.from(configPayload), signal);
      if (!ok) return { success: false, message: "Upload failed (check endpoint/auth)" };

      // Put files to S3
      for (const [dirId, b64] of Object.entries(cookiesBlob)) {
        assertSyncNotAborted(signal);
        if (!b64) continue;
        const entry = parseCookieBlob(b64);
        const body = JSON.stringify({ dirId, profileName: getSyncProfileName(syncSnapshot, dirId), timestamp: now, count: entry.length, cookies: entry });
        await s3Put(sync, `cookies-${dirId}.json`, Buffer.from(body), signal);
      }
      for (const [dirId, b64] of Object.entries(localStorageBlobs)) {
        assertSyncNotAborted(signal);
        await s3Put(sync, `localstorage-${dirId}.tgz`, Buffer.from(b64, "base64"), signal);
      }
      for (const [dirId, b64] of Object.entries(prefsBlobs)) {
        assertSyncNotAborted(signal);
        await s3Put(sync, `preferences-${dirId}.json`, Buffer.from(b64, "base64"), signal);
      }

      // Extension repository packages (per-key upload, like cookies/localStorage).
      let totalExts = 0;
      for (const entry of listExtensionRepository()) {
        assertSyncNotAborted(signal);
        // Find the package file: chrome-store → package.crx, local → package.zip or unpacked dir.
        const repoDir = getExtensionRepoEntryDir(entry.id);
        let pkgPath = path.join(repoDir, "package.crx");
        let pkgKey = `extension-${entry.id}.crx`;
        if (!fs.existsSync(pkgPath)) {
          pkgPath = path.join(repoDir, "package.zip");
          pkgKey = `extension-${entry.id}.zip`;
        }
        if (fs.existsSync(pkgPath)) {
          const buf = fs.readFileSync(pkgPath);
          if (buf.length > 0 && buf.length <= 80 * 1024 * 1024) {
            const ok = await s3Put(sync, pkgKey, buf, signal);
            if (ok) totalExts++;
          }
        }
      }

      const latestConfig2 = getConfig();
      markAllProfilesSynced(latestConfig2, now, { cloakPreferences: cloakPreferenceHashes });
      saveConfig(latestConfig2);

      const parts = [`${cloakDirIds.length} profiles`];
      if (totalCookies > 0) parts.push(`${totalCookies} cookies`);
      if (totalLs > 0) parts.push(`${totalLs} localStorage`);
      if (totalPrefs > 0) parts.push(`${totalPrefs} preferences`);
      if (totalExts > 0) parts.push(`${totalExts} extensions`);

      return { success: true, message: `Synced: ${parts.join(", ")}`, transferredBytes: configPayload.length };
    } catch (e: any) {
      if (signal?.aborted) throw e;
      return { success: false, message: e.message };
    }
  },

  // ── Pull ──
  async pull(signal?: AbortSignal): Promise<SyncResult> {
    assertSyncNotAborted(signal);
    const sync = getSyncConfig();
    if (!sync.endpoint || !sync.bucket) {
      return { success: false, message: "Endpoint and bucket required" };
    }

    try {
      const fetched = await fetchSyncConfig(sync, signal);
      if (!fetched.ok) {
        return { success: false, message: fetched.message };
      }

      const payload = fetched.payload;
      const raw = gunzipBase64Field(payload.data, MAX_CONFIG_GZIP_BYTES, MAX_CONFIG_JSON_BYTES, "sync config");
      const remoteConfig = sanitizeRemoteConfig(JSON.parse(raw.toString()) as MgmtConfig);
      assertSyncNotAborted(signal);

      const pullTimestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();
      const importedPreferenceIds = new Set<string>();
      const importedPreferenceHashes: Record<string, string> = {};
      const allowedProfileIds = new Set(Object.keys(remoteConfig.cloakProfiles || {}));
      if (allowedProfileIds.size > MAX_SYNC_PROFILES) throw new Error("Remote config contains too many profiles");
      validateArtifactProfileIds(payload, allowedProfileIds);
      let aggregateCookies = 0;
      let aggregateLocalStorage = 0;
      let aggregateLocalStorageBytes = 0;
      let aggregatePreferenceBytes = 0;

      for (const dirId of allowedProfileIds) {
        assertSyncNotAborted(signal);
        validateDirId(dirId);
        ensureProfileDefaultDir(dirId);
      }

      // Cookies
      let importedCookies = 0;
      if (payload.cookies && typeof payload.cookies === "object") {
        for (const [dirId, b64] of Object.entries(payload.cookies)) {
          assertSyncNotAborted(signal);
          validateDirId(dirId);
          if (!b64) continue;
          try {
            const list = parseCookieBlob(b64);
            aggregateCookies += list.length;
            if (aggregateCookies > MAX_PULL_COOKIES) throw new Error("Remote config contains too many cookies");
            if (list.length > 0) {
              if (cdpCookieService.hasRunningChrome(dirId)) {
                const n = await withTimeout(cdpCookieService.importCookies(dirId, list, signal), 30000, signal) ?? 0;
                assertSyncNotAborted(signal);
                console.log(`[sync] pull: ${dirId.slice(0, 8)} ← ${n} cookies (CDP)`);
                importedCookies += n;
              } else {
                cdpCookieService.queueImport(dirId, list);
                console.log(`[sync] pull: ${dirId.slice(0, 8)} queued ${list.length} cookies for next launch`);
                importedCookies += list.length;
              }
            }
          } catch (e: any) {
            if (signal?.aborted) throw e;
            console.error(`[sync] pull cookie error for ${dirId}:`, e.message);
          }
        }
      }

      // LocalStorage
      let importedLs = 0;
      if (payload.localStorage && typeof payload.localStorage === "object") {
        for (const [dirId, b64] of Object.entries(payload.localStorage)) {
          assertSyncNotAborted(signal);
          validateDirId(dirId);
          if (isProfileRunningForRestore(dirId)) {
            console.log(`[sync] pull: skipped localStorage for running profile ${dirId.slice(0, 8)}`);
            continue;
          }
          aggregateLocalStorage++;
          if (aggregateLocalStorage > MAX_PULL_LOCAL_STORAGE_ARCHIVES) throw new Error("Remote config contains too many localStorage archives");
          const archive = decodeBase64Field(b64, MAX_LOCAL_STORAGE_TGZ_BYTES, "localStorage");
          const release = acquireRestoreLock(dirId);
          try {
            const result = importLocalStorage(dirId, archive, MAX_PULL_LOCAL_STORAGE_BYTES - aggregateLocalStorageBytes, signal);
            aggregateLocalStorageBytes += result.bytesWritten;
            if (result.imported) importedLs++;
          } finally {
            release();
          }
        }
      }

      // Preferences
      let importedPrefs = 0;
      if (payload.preferences && typeof payload.preferences === "object") {
        for (const [dirId, b64] of Object.entries(payload.preferences)) {
          assertSyncNotAborted(signal);
          validateDirId(dirId);
          if (isProfileRunningForRestore(dirId)) {
            console.log(`[sync] pull: skipped preferences for running profile ${dirId.slice(0, 8)}`);
            continue;
          }
          try {
            const rawPrefs = gunzipBase64Field(b64, MAX_PREFERENCES_GZIP_BYTES, MAX_PREFERENCES_JSON_BYTES, "preferences");
            aggregatePreferenceBytes += rawPrefs.length;
            if (aggregatePreferenceBytes > MAX_PULL_PREFERENCES_BYTES) throw new Error("Remote config contains too much preferences data");
            validatePreferencesJson(rawPrefs);
            const release = acquireRestoreLock(dirId);
            try {
              if (cdpCookieService.hasRunningChrome(dirId) || statusCloak(dirId).running) {
                console.log(`[sync] pull: skipped preferences for running profile ${dirId.slice(0, 8)}`);
                continue;
              }
              const prefPath = resolveProfileFile(dirId, "Default", "Preferences");
              safeExistingParentInsideProfile(dirId, ["Default", "Preferences"]);
              fs.mkdirSync(path.dirname(prefPath), { recursive: true });
              writeFileAtomic(prefPath, rawPrefs);
            } finally {
              release();
            }
            importedPreferenceHashes[dirId] = rawPrefs.toString("base64");
            importedPreferenceIds.add(dirId);
            importedPrefs++;
          } catch (e: any) {
            if (signal?.aborted) throw e;
            console.error(`[sync] pull preferences error for ${dirId}:`, e.message);
          }
        }
      }

      const latestConfig = getConfig();
      const merged = {
        ...remoteConfig,
        ...latestConfig,
        defaultProxy: remoteConfig.defaultProxy || latestConfig.defaultProxy,
        proxies: { ...(remoteConfig.proxies || {}), ...latestConfig.proxies },
        sync: latestConfig.sync,
        cloakProfiles: { ...(remoteConfig.cloakProfiles || {}), ...(latestConfig.cloakProfiles || {}) },
      } as MgmtConfig;

      markRemoteProfilesSynced(merged, remoteConfig, pullTimestamp, {
        preferences: importedPreferenceIds,
        preferenceHashes: importedPreferenceHashes,
      });
      saveConfig(merged);

      // Extensions: for each remote entry not present locally (or stale hash),
      // pull the package from S3 and install it via installLocalExtension.
      let importedExts = 0;
      let extensionBytes = 0;
      const remoteExts = (remoteConfig as any).extensionRepository || {};
      const remoteExtEntries = Object.entries(remoteExts) as Array<[string, any]>;
      if (remoteExtEntries.length > MAX_SYNC_EXTENSIONS) throw new Error("Remote config contains too many extensions");
      const localExts = listExtensionRepository();
      const localExtMap = new Map(localExts.map((e) => [e.id, e]));
      for (const [extId, remoteEntry] of remoteExtEntries) {
        assertSyncNotAborted(signal);
        if (!EXTENSION_HASH_RE.test(String(remoteEntry?.packageHash || "")) || !EXTENSION_HASH_RE.test(String(remoteEntry?.manifestHash || ""))) {
          console.error(`[sync] pull: extension ${extId.slice(0, 16)} missing verified hashes, skipping`);
          continue;
        }
        const local = localExtMap.get(extId);
        if (local && local.manifestHash === remoteEntry.manifestHash && local.packageHash === remoteEntry.packageHash) continue; // up-to-date
        if (extensionBytes >= MAX_PULL_EXTENSION_BYTES) throw new Error("Remote extension packages are too large");
        const keyExt = remoteEntry.source === "chrome-web-store" ? "crx" : "zip";
        let pkg = await s3Get(sync, `extension-${extId}.${keyExt}`, signal);
        if (!pkg) pkg = await s3Get(sync, `extension-${extId}.${keyExt === "crx" ? "zip" : "crx"}`, signal);
        if (!pkg) {
          console.log(`[sync] pull: extension ${extId.slice(0, 16)} package not on remote, skipping`);
          continue;
        }
        extensionBytes += pkg.length;
        if (extensionBytes > MAX_PULL_EXTENSION_BYTES) throw new Error("Remote extension packages are too large");
        const tmpFile = path.join(os.tmpdir(), `cloak-ext-pull-${extId}-${Date.now()}.${remoteEntry.source === "chrome-web-store" ? "crx" : "zip"}`);
        try {
          fs.writeFileSync(tmpFile, pkg, { mode: 0o600 });
          assertSyncNotAborted(signal);
          await restoreSyncedExtensionPackage(extId, tmpFile, remoteEntry, signal);
          assertSyncNotAborted(signal);
          importedExts++;
        } catch (e: any) {
          if (signal?.aborted) throw e;
          console.error(`[sync] pull: failed to install extension ${extId.slice(0, 16)}:`, e.message);
        } finally {
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      }

      const parts: string[] = [];
      if (importedCookies > 0) parts.push(`${importedCookies} cookies`);
      if (importedLs > 0) parts.push(`${importedLs} localStorage`);
      if (importedPrefs > 0) parts.push(`${importedPrefs} preferences`);
      if (importedExts > 0) parts.push(`${importedExts} extensions`);

      return { success: true, message: `Pulled from ${new Date(pullTimestamp).toISOString()}${parts.length ? " (" + parts.join(", ") + ")" : ""}` };
    } catch (e: any) {
      if (signal?.aborted) throw e;
      return { success: false, message: e.message };
    }
  },

  getStatus() {
    const sync = getSyncConfig();
    return {
      enabled: sync.enabled || false,
      configured: !!(sync.endpoint && sync.bucket && sync.accessKey),
      endpoint: sync.endpoint || "",
      bucket: sync.bucket || "",
      accessKeyMasked: maskKey(sync.accessKey || ""),
    };
  },
};

// LocalStorage LevelDB export/import
async function exportLocalStorage(dirId: string, signal?: AbortSignal): Promise<Buffer | null> {
  assertSyncNotAborted(signal);
  const lsDir = resolveProfileFile(dirId, "Default", "Local Storage", "leveldb");
  if (!fs.existsSync(lsDir)) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cloak-ls-export-${dirId.slice(0, 8)}-`));
  try {
    const tmpFile = path.join(tmpDir, "localstorage.tgz");
    const result = await spawnTar(["--no-xattrs", "-czf", tmpFile, "-C", lsDir, "--exclude", "LOCK", "."], 15000, signal);
    if (!result || !fs.existsSync(tmpFile)) return null;
    assertSyncNotAborted(signal);
    const archive = fs.readFileSync(tmpFile);
    assertSyncNotAborted(signal);
    return archive.length > MAX_LOCAL_STORAGE_TGZ_BYTES ? null : archive;
  } catch (e: any) {
    if (signal?.aborted) throw e;
    console.error(`[sync] exportLocalStorage:`, e.message);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { console.error(`[sync] failed to remove temp localStorage export dir:`, e); }
  }
}

function importLocalStorage(dirId: string, tgzData: Buffer, remainingByteBudget = MAX_PULL_LOCAL_STORAGE_BYTES, signal?: AbortSignal): { imported: boolean; bytesWritten: number } {
  assertSyncNotAborted(signal);
  const lsDir = resolveProfileFile(dirId, "Default", "Local Storage", "leveldb");
  if (tgzData.length > MAX_LOCAL_STORAGE_TGZ_BYTES || remainingByteBudget <= 0) return { imported: false, bytesWritten: 0 };
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `cloak-ls-stage-${dirId.slice(0, 8)}-`));
  let backupDir: string | null = null;
  try {
    const extracted = extractSafeLocalStorageArchive(tgzData, stagingDir, remainingByteBudget, signal);
    if (extracted.files === 0) return { imported: false, bytesWritten: 0 };
    assertSyncNotAborted(signal);
    if (isProfileRunningForRestore(dirId)) {
      console.log(`[sync] pull: skipped localStorage for running profile ${dirId.slice(0, 8)}`);
      return { imported: false, bytesWritten: 0 };
    }
    const parentDir = safeExistingParentInsideProfile(dirId, ["Default", "Local Storage", "leveldb"]);
    assertSyncNotAborted(signal);
    fs.mkdirSync(parentDir, { recursive: true });
    backupDir = fs.existsSync(lsDir) ? path.join(parentDir, `.leveldb-backup-${process.pid}-${Date.now()}`) : null;
    if (backupDir) fs.renameSync(lsDir, backupDir);
    try {
      assertSyncNotAborted(signal);
      fs.renameSync(stagingDir, lsDir);
      if (backupDir) fs.rmSync(backupDir, { recursive: true, force: true });
      backupDir = null;
      return { imported: true, bytesWritten: extracted.bytesWritten };
    } catch (e) {
      if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(lsDir)) fs.renameSync(backupDir, lsDir);
      throw e;
    }
  } catch (e: any) {
    if (signal?.aborted) throw e;
    console.error(`[sync] importLocalStorage:`, e.message);
    return { imported: false, bytesWritten: 0 };
  } finally {
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    if (backupDir && fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

function spawnTar(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  assertSyncNotAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: "ignore" });
    let settled = false;
    const finish = (ok: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(ok);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(false, new Error("Sync operation cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, timeoutMs);
    child.on("error", (e) => finish(false, e));
    child.on("exit", (code) => finish(code === 0));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveProfileDir(dirId: string): string {
  validateDirId(dirId);
  const baseDir = path.resolve(getProfilesDir());
  const profileDir = path.resolve(baseDir, dirId);
  if (!isPathInside(profileDir, baseDir)) {
    throw new Error(`Profile path escapes cloak-profiles: ${JSON.stringify(dirId)}`);
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

function ensureProfileDefaultDir(dirId: string): void {
  const profileDir = resolveProfileDir(dirId);
  if (fs.existsSync(profileDir) && fs.lstatSync(profileDir).isSymbolicLink()) {
    throw new Error(`Profile path is a symlink: ${dirId}`);
  }
  fs.mkdirSync(resolveProfileFile(dirId, "Default"), { recursive: true, mode: 0o700 });
}

function safeExistingParentInsideProfile(dirId: string, targetSegments: string[]): string {
  const profileDir = resolveProfileDir(dirId);
  const profileReal = fs.existsSync(profileDir) ? fs.realpathSync(profileDir) : profileDir;
  let current = profileDir;
  for (const segment of targetSegments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Profile path contains symlink: ${dirId}`);
    const real = fs.realpathSync(current);
    if (!isPathInside(real, profileReal)) throw new Error(`Profile path escapes cloak-profiles: ${dirId}`);
  }
  return path.dirname(resolveProfileFile(dirId, ...targetSegments));
}

function extractSafeLocalStorageArchive(tgzData: Buffer, targetRoot: string, byteBudget = MAX_PULL_LOCAL_STORAGE_BYTES, signal?: AbortSignal): { files: number; bytesWritten: number } {
  assertSyncNotAborted(signal);
  const tarData = zlib.gunzipSync(tgzData, { maxOutputLength: Math.min(MAX_LOCAL_STORAGE_TAR_BYTES, byteBudget + 1024 * 1024) });
  assertSyncNotAborted(signal);
  let offset = 0;
  let bytesWritten = 0;
  const entries: Array<{ path: string; start: number; end: number }> = [];
  const rootReal = fs.realpathSync(targetRoot);

  while (offset + 512 <= tarData.length) {
    assertSyncNotAborted(signal);
    const header = tarData.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;

    const entryPath = normalizeTarEntryPath(readTarString(header, 0, 100), readTarString(header, 345, 155));
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const size = readTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (size < 0 || dataEnd > tarData.length) throw new Error("LocalStorage archive has invalid entry size");
    if (typeFlag !== "0" && typeFlag !== "5") throw new Error("LocalStorage archive contains non-regular entries");
    if (!isAllowedLocalStoragePath(entryPath)) throw new Error("LocalStorage archive contains unsafe paths");

    if (typeFlag === "0" && entryPath) {
      bytesWritten += size;
      if (bytesWritten > byteBudget) throw new Error("LocalStorage archive exceeds pull byte budget");
      if (entries.length >= MAX_LOCAL_STORAGE_FILES) throw new Error("LocalStorage archive contains too many files");
      const target = path.resolve(rootReal, entryPath);
      if (!isPathInside(target, rootReal)) throw new Error("LocalStorage archive escapes extraction directory");
      entries.push({ path: entryPath, start: dataStart, end: dataEnd });
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  for (const entry of entries) {
    assertSyncNotAborted(signal);
    const target = path.resolve(rootReal, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, tarData.subarray(entry.start, entry.end), { flag: "wx", mode: 0o600 });
  }

  return { files: entries.length, bytesWritten };
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
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return true;
  const name = path.posix.basename(normalized);
  if (normalized.split("/").length > 2) return false;
  if (name === "LOCK") return false;
  return name.endsWith(".ldb") || name.endsWith(".log") || name.startsWith("MANIFEST-") || name === "CURRENT";
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
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function isProfileRunningForRestore(dirId: string): boolean {
  validateDirId(dirId);
  if (cdpCookieService.hasRunningChrome(dirId)) return true;
  try {
    if (statusCloak(dirId).running) return true;
  } catch (e) {
    console.error(`[sync] failed to check Cloak status for ${dirId}:`, e);
    return true;
  }
  const profileDir = resolveProfileDir(dirId);
  for (const rel of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      const lockPath = resolveProfileFile(dirId, ...rel.split(path.sep));
      if (fs.existsSync(lockPath)) return true;
    } catch (e) {
      console.error(`[sync] failed to check profile lock ${rel} for ${dirId}:`, e);
      return true;
    }
  }
  try {
    if (fs.existsSync(profileDir) && fs.lstatSync(profileDir).isSymbolicLink()) return true;
  } catch (e) {
    console.error(`[sync] failed to inspect profile dir for ${dirId}:`, e);
    return true;
  }
  return false;
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
  const value = boundedCookieText(cookie.value ?? "", 4096, "value", true);
  const cookiePath = boundedCookieText(cookie.path || "/", 1024, "path");
  const expires = cookie.expires === null || cookie.expires === undefined ? null : Number(cookie.expires);
  if (expires !== null && (!Number.isFinite(expires) || expires < -1 || expires > 4102444800)) throw new Error("invalid cookie expiry");
  return {
    domain,
    name,
    value,
    path: cookiePath,
    expires,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: Number.isInteger(cookie.sameSite) ? cookie.sameSite : 0,
  };
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

async function fetchSyncConfig(sync: ReturnType<typeof getSyncConfig>, signal?: AbortSignal): Promise<{ ok: true; payload: any } | { ok: false; message: string }> {
  const payload = await fetchSyncPayload(sync, SYNC_CONFIG_KEY, false, signal);
  return payload;
}

async function fetchRemoteCookiesForPush(sync: ReturnType<typeof getSyncConfig>, signal?: AbortSignal): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  try {
    const fetched = await fetchSyncPayload(sync, SYNC_CONFIG_KEY, true, signal);
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
  if (!cookiesOnly && typeof payload.data !== "string") throw new Error("Remote config payload is missing data");
  for (const field of ["cookies", "localStorage", "preferences"]) {
    if (payload[field] !== undefined && (!payload[field] || typeof payload[field] !== "object" || Array.isArray(payload[field]))) {
      throw new Error(`Remote config ${field} must be an object`);
    }
  }
}

function validateArtifactProfileIds(payload: any, allowedProfileIds: Set<string>): void {
  for (const field of ["cookies", "localStorage", "preferences"]) {
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

async function s3Put(sync: ReturnType<typeof getSyncConfig>, key: string, body: Buffer, signal?: AbortSignal): Promise<boolean> {
  assertSyncNotAborted(signal);
  const objPath = `/${sync.bucket}/${key}`;
  const url = `${sync.endpoint}${objPath}`;
  const h = signS3Request({
    method: "PUT",
    endpoint: sync.endpoint,
    objectPath: objPath,
    body,
    accessKey: sync.accessKey,
    secretKey: decryptSecretOr(sync.secretKey),
  });
  try {
    // Node's fetch accepts Buffer at runtime; DOM and Node declarations do not
    // currently agree on Buffer<ArrayBufferLike> as a BodyInit.
    const resp = await fetch(url, { method: "PUT", headers: h, body: body as any, signal: combineAbortSignals(signal, 30000) });
    if (!resp.ok) {
      const detail = await readS3ErrorDetail(resp);
      console.error(`[sync] PUT ${key} failed: HTTP ${resp.status} ${detail}`);
    }
    return resp.ok;
  } catch (e: any) {
    if (signal?.aborted) throw e;
    console.error(`[sync] PUT ${key} error:`, e?.message || String(e));
    return false;
  }
}

/** Fetch an object from S3 as a Buffer (for extension package pull). Returns null on 404/error. */
async function s3Get(sync: ReturnType<typeof getSyncConfig>, key: string, signal?: AbortSignal): Promise<Buffer | null> {
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
    if (length > MAX_EXTENSION_PACKAGE_BYTES) throw new Error("Remote extension package is too large");
    assertSyncNotAborted(signal);
    return await readResponseBytesLimited(resp, MAX_EXTENSION_PACKAGE_BYTES, "Remote extension package is too large", signal);
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
  return listExtensions(dirId).map(e => ({ id: e.id, name: e.name, version: e.version }));
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
  for (const [dirId, profile] of Object.entries(cfg.cloakProfiles || {}) as Array<[string, any]>) {
    validateDirId(dirId);
    profiles[dirId] = {
      name: String(profile.name || dirId.slice(0, 8)),
      fingerprintMode: profile.fingerprintMode === "off" ? "off" : "managed",
      browserVersion: typeof profile.browserVersion === "string" ? profile.browserVersion : null,
      allowThirdPartyCookies: profile.allowThirdPartyCookies === true,
      fingerprintSeed: Number.isInteger(profile.fingerprintSeed) ? profile.fingerprintSeed : 12345,
      platform: profile.platform === "macos" ? "macos" : "windows",
      timezone: profile.timezone || null,
      locale: profile.locale || null,
      webrtcMode: profile.webrtcMode === "real" || profile.webrtcMode === "altered" || profile.webrtcMode === "disable"
        ? profile.webrtcMode
        : "auto",
      webrtcIp: profile.webrtcIp || null,
      geolocationMode: profile.geolocationMode === "disable" || profile.geolocationMode === "custom" ? profile.geolocationMode : "real",
      geolocationLatitude: Number.isFinite(profile.geolocationLatitude) ? profile.geolocationLatitude : null,
      geolocationLongitude: Number.isFinite(profile.geolocationLongitude) ? profile.geolocationLongitude : null,
      geolocationAccuracy: Number.isFinite(profile.geolocationAccuracy) ? profile.geolocationAccuracy : null,
      gpuVendor: profile.gpuVendor || null,
      gpuRenderer: profile.gpuRenderer || null,
      hardwareConcurrency: Number.isInteger(profile.hardwareConcurrency) ? profile.hardwareConcurrency : null,
      deviceMemory: Number.isInteger(profile.deviceMemory) ? profile.deviceMemory : null,
      screenWidth: Number.isInteger(profile.screenWidth) ? profile.screenWidth : null,
      screenHeight: Number.isInteger(profile.screenHeight) ? profile.screenHeight : null,
      storageQuota: Number.isInteger(profile.storageQuota) ? profile.storageQuota : null,
      taskbarHeight: Number.isInteger(profile.taskbarHeight) ? profile.taskbarHeight : null,
      fontsDir: null,
      proxyMode: profile.proxyMode,
      proxyName: profile.proxyName || null,
      note: profile.note || null,
      extensions: profile.extensions || {},
      syncedAt: profile.syncedAt,
      syncedHash: profile.syncedHash,
    };
  }

  const proxies: Record<string, Omit<ProxyConfig, "password">> = {};
  for (const [name, proxy] of Object.entries(cfg.proxies || {}) as Array<[string, any]>) {
    proxies[name] = {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
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

  return {
    version: cfg.version || 3,
    cloakBin: "auto",
    defaultProxy: cfg.defaultProxy || "default",
    proxies,
    sync: {
      enabled: Boolean(cfg.sync?.enabled),
      endpoint: cfg.sync?.endpoint || "",
      bucket: cfg.sync?.bucket || "",
    },
    cloakProfiles: profiles,
    extensionRepository: extensionRepo,
  } as SyncSafeConfig;
}

function markAllProfilesSynced(config: MgmtConfig | SyncSafeConfig, timestamp: number, artifacts: { cloakPreferences: Record<string, string> }): void {
  const cfg = config as any;
  for (const [dirId, profile] of Object.entries(cfg.cloakProfiles || {}) as Array<[string, any]>) {
    if (!artifacts.cloakPreferences[dirId]) {
      delete profile.syncedAt;
      delete profile.syncedHash;
      continue;
    }
    profile.syncedAt = timestamp;
    profile.syncedHash = hashProfileMeta(profile, artifacts.cloakPreferences[dirId]);
  }
}

function getSyncProfileName(config: MgmtConfig | SyncSafeConfig, dirId: string): string {
  const cfg = config as any;
  return cfg.cloakProfiles?.[dirId]?.name || dirId.slice(0, 8);
}

function markRemoteProfilesSynced(merged: MgmtConfig, remoteConfig: MgmtConfig, timestamp: number, artifacts: { preferences: Set<string>; preferenceHashes: Record<string, string> }): void {
  const local = merged as any;
  const remote = remoteConfig as any;
  const remoteProfiles = remote.cloakProfiles || {};
  const mergedProfiles = local.cloakProfiles || {};
  for (const [dirId, remoteProfile] of Object.entries(remoteProfiles)) {
    const mergedProfile = mergedProfiles[dirId];
    if (!mergedProfile) continue;
    if (!(remoteProfile as any).syncedHash || !artifacts.preferences.has(dirId)) continue;
    const artifactHash = artifacts.preferenceHashes[dirId] || null;
    if (hashProfileMeta(mergedProfile, artifactHash || undefined) === hashProfileMeta(remoteProfile, artifactHash || undefined)) {
      mergedProfile.syncedAt = timestamp;
      mergedProfile.syncedHash = (remoteProfile as any).syncedHash || hashProfileMeta(mergedProfile, artifactHash || undefined);
    }
  }
}

function hashProfileMeta(profile: any, artifactHash?: string): string {
  const clean = JSON.parse(JSON.stringify(profile || {}));
  delete clean.syncedAt;
  delete clean.syncedHash;
  if (artifactHash) clean.__artifactHash = artifactHash;
  return createHash("sha256").update(JSON.stringify(sortKeys(clean))).digest("hex");
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function getHostname(): string { try { return os.hostname(); } catch { return "unknown"; } }
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
};
