import type { BrowserProfileMeta, ProfilePreferencesSnapshot, ProfileSyncBaseline } from "../types.js";

/** Shared F08/archive/sync content boundary. Device paths, credentials, locks,
 * capture times and synchronization bookkeeping are deliberately not content. */
export const PORTABLE_PROFILE_FIELDS = [
  "name", "fingerprintMode", "engine", "browserVersion", "allowThirdPartyCookies",
  "fingerprintSeed", "platform", "timezone", "locale", "webrtcMode", "webrtcIp",
  "geolocationMode", "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy",
  "gpuVendor", "gpuRenderer", "hardwareConcurrency", "deviceMemory", "screenWidth",
  "screenHeight", "storageQuota", "taskbarHeight", "renderScaleMode", "windowTitlePrefix",
  "appUrl", "drm", "proxyMode", "proxyName", "note", "tags", "preset",
  "extensions", "fingerprintBaseline",
] as const satisfies readonly (keyof BrowserProfileMeta)[];

export type PortableProfileContent = Pick<BrowserProfileMeta, (typeof PORTABLE_PROFILE_FIELDS)[number]>;
const HASH_RE = /^[0-9a-f]{64}$/i;
const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A proof descriptor, never a path, inline body or unchecked producer object. */
export function parseProfilePreferencesSnapshot(value: unknown): ProfilePreferencesSnapshot | null {
  if (!record(value)) return null;
  if (value.state === "absent" && exactKeys(value, ["state"])) return { state: "absent" };
  if (value.state !== "present" || !exactKeys(value, ["state", "sha256", "bytes"]) ||
      typeof value.sha256 !== "string" || !HASH_RE.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) return null;
  return { state: "present", sha256: value.sha256.toLowerCase(), bytes: value.bytes as number };
}

/** Pure validation shared by config loading, setters and sync readers. */
export function parseProfileSyncBaseline(value: unknown): ProfileSyncBaseline | null {
  if (!record(value) || !exactKeys(value, ["version", "targetId", "snapshotId", "contentHash", "preferences", "timestamp"]) ||
      value.version !== 1 || typeof value.targetId !== "string" || !HASH_RE.test(value.targetId) ||
      typeof value.contentHash !== "string" || !HASH_RE.test(value.contentHash) ||
      typeof value.snapshotId !== "string" || !SNAPSHOT_ID_RE.test(value.snapshotId) ||
      !Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) return null;
  const preferences = parseProfilePreferencesSnapshot(value.preferences);
  if (!preferences) return null;
  return { version: 1, targetId: value.targetId.toLowerCase(), snapshotId: value.snapshotId,
    contentHash: value.contentHash.toLowerCase(), preferences, timestamp: value.timestamp as number };
}
