import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppDataDir, getProfilesDir, getSyncConfig, portableProfileContent } from "../config-manager.js";
import { parseProfilePreferencesSnapshot, parseProfileSyncBaseline } from "../profile-portability.js";
import { validateDirId } from "../utils.js";
import type { ProfilePreferencesSnapshot, ProfileSyncBaseline, ProfileSyncReason, ProfileSyncScope, ProfileSyncStatus } from "../../types.js";

export { parseProfileSyncBaseline } from "../profile-portability.js";
export const PROFILE_SYNC_SCOPE: ProfileSyncScope = "portable-profile+preferences";
const MAX_PREFERENCES_BYTES = 10 * 1024 * 1024;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, field]) => [key, canonical(field)]));
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function profilePreferencesSnapshot(raw: Buffer | null): ProfilePreferencesSnapshot {
  if (raw === null) return { state: "absent" };
  if (!Buffer.isBuffer(raw)) throw new Error("Preferences snapshot requires Buffer or confirmed absence");
  return { state: "present", sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length };
}

/** Target identity is storage scope, never auth/consent/device/enabled state. */
export function getProfileSyncTarget(sync: { endpoint: string; bucket: string }): string {
  const endpoint = new URL(String(sync.endpoint || "").trim());
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Invalid profile sync target endpoint");
  }
  endpoint.search = ""; // match saved endpoint normalization, not query credentials
  const bucket = String(sync.bucket || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || bucket.includes(".-") || bucket.includes("-.")) {
    throw new Error("Invalid profile sync target bucket");
  }
  return digest({ version: 1, endpoint: endpoint.toString().replace(/\/+$/, ""), bucket });
}

export function profileContentHash(profile: unknown, preferences: ProfilePreferencesSnapshot): string {
  const parsed = parseProfilePreferencesSnapshot(preferences);
  if (!parsed) throw new Error("Invalid profile Preferences snapshot");
  return digest({ version: 1, scope: PROFILE_SYNC_SCOPE, profile: portableProfileContent(profile), preferences: parsed });
}

export function createProfileSyncBaseline(profile: unknown, preferences: ProfilePreferencesSnapshot, targetId: string, snapshotId: string, timestamp: number): ProfileSyncBaseline {
  const baseline = parseProfileSyncBaseline({ version: 1, targetId, snapshotId,
    contentHash: profileContentHash(profile, preferences), preferences, timestamp });
  if (!baseline) throw new Error("Invalid profile sync baseline identity or timestamp");
  return baseline;
}

export interface ProfileSyncState {
  syncStatus: ProfileSyncStatus;
  syncedAt: number | null;
  syncScope: ProfileSyncScope;
  syncReason: ProfileSyncReason;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Only ENOENT under checked real parents proves absence. Reject links before
 * reading; verify the opened descriptor and final path to detect replacements. */
function readPreferences(dirId: string): ProfilePreferencesSnapshot {
  validateDirId(dirId);
  const profileDir = path.join(getProfilesDir(), dirId);
  const parent = path.join(profileDir, "Default");
  for (const directory of [getAppDataDir(), getProfilesDir(), profileDir, parent]) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(directory); }
    catch (error) { if (missing(error)) return profilePreferencesSnapshot(null); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Preferences ancestor is not a real directory");
  }
  const file = path.join(parent, "Preferences");
  let before: fs.Stats;
  try { before = fs.lstatSync(file); }
  catch (error) { if (missing(error)) return profilePreferencesSnapshot(null); throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PREFERENCES_BYTES) throw new Error("Preferences is not a bounded regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error("Preferences changed before reading");
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const finalPath = fs.lstatSync(file);
    if (raw.length > MAX_PREFERENCES_BYTES || raw.length !== opened.size || !sameFile(opened, after) ||
        finalPath.isSymbolicLink() || !sameFile(after, finalPath)) throw new Error("Preferences changed while reading");
    return profilePreferencesSnapshot(raw);
  } finally {
    fs.closeSync(fd);
  }
}

/** Read-only classification. Legacy timestamps never establish clean state,
 * and no getter writes/upgrades/recomputes a stored synchronization marker. */
export function readProfileSyncState(dirId: string, rawMeta: unknown): ProfileSyncState {
  validateDirId(dirId);
  const meta = rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta) ? rawMeta as Record<string, unknown> : {};
  const baseline = parseProfileSyncBaseline(meta.syncBaseline);
  const legacyTime = typeof meta.syncedAt === "number" && Number.isSafeInteger(meta.syncedAt) && meta.syncedAt >= 0 ? meta.syncedAt : null;
  const state = (syncStatus: ProfileSyncStatus, syncReason: ProfileSyncReason): ProfileSyncState => ({
    syncStatus, syncedAt: baseline?.timestamp ?? legacyTime, syncScope: PROFILE_SYNC_SCOPE, syncReason,
  });
  if (!baseline) {
    if (meta.syncBaseline !== undefined) return state("unknown", "invalid-baseline");
    if (meta.syncedAt !== undefined || meta.syncedHash !== undefined) return state("unknown", "legacy-marker");
    return state("never", "no-baseline");
  }
  let targetId: string;
  try { targetId = getProfileSyncTarget(getSyncConfig()); }
  catch { return state("unknown", "target-unavailable"); }
  if (baseline.targetId !== targetId) return state("unknown", "target-mismatch");
  let preferences: ProfilePreferencesSnapshot;
  try { preferences = readPreferences(dirId); }
  catch { return state("unknown", "preferences-unavailable"); }
  let currentHash: string;
  try { currentHash = profileContentHash(meta, preferences); }
  catch { return state("unknown", "content-unavailable"); }
  if (currentHash !== baseline.contentHash) return state("dirty", "content-changed");
  // A structurally valid marker is not enough: matching content cannot also
  // assert contradictory Preferences presence/bytes. Retain that uncertainty.
  if (digest(preferences) !== digest(baseline.preferences)) return state("unknown", "invalid-baseline");
  return state("synced", "baseline-match");
}
