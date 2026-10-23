import type { BrowserProfileMeta, ProfilePreferencesSnapshot, ProfileSyncBaseline, ProfileHistoryBaseline, HistoryCoverage, HistoryArtifact, HistorySchema } from "../types.js";

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

const historyEngine = (value: unknown) => value === "chromium" || value === "firefox";
const historyHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const historyId = (value: unknown): value is string => typeof value === "string" && SNAPSHOT_ID_RE.test(value);
const historyTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value);

export function parseProfileHistoryBaseline(value: unknown): ProfileHistoryBaseline | null {
  if (!record(value) || !exactKeys(value, ["version", "targetId", "snapshotId", "engine", "state", "semanticHash", "schemaHash", "timestamp"]) ||
      value.version !== 1 || !historyHash(value.targetId) || !historyId(value.snapshotId) || !historyEngine(value.engine) || !historyTime(value.timestamp) ||
      (value.state === "present" ? !historyHash(value.semanticHash) || !historyHash(value.schemaHash) : value.state !== "absent" || value.semanticHash !== null || value.schemaHash !== null)) return null;
  return { ...value } as unknown as ProfileHistoryBaseline;
}

/** Inline proof only: exact engine/path/digest/budgets, no caller-supplied paths. */
export function parseHistoryCoverage(value: unknown): HistoryCoverage | null {
  if (!record(value) || Object.keys(value).some((key) => !["version", "snapshotId", "dirId", "engine", "state", "freshness", "capturedAt", "artifact", "code"].includes(key)) ||
      value.version !== 1 || !historyId(value.snapshotId) || typeof value.dirId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.dirId) || !historyEngine(value.engine) ||
      value.code !== undefined && (typeof value.code !== "string" || !/^[A-Z0-9_]{1,80}$/.test(value.code))) return null;
  if (["unselected", "failed"].includes(value.state as string)) {
    if (value.freshness !== "not-covered" || value.artifact !== undefined || value.capturedAt !== undefined) return null;
    return { ...value } as unknown as HistoryCoverage;
  }
  if (value.state === "absent") {
    if (value.freshness !== "captured" || !historyTime(value.capturedAt) || value.artifact !== undefined) return null;
    return { ...value } as unknown as HistoryCoverage;
  }
  if (!["complete", "empty", "preserved"].includes(value.state as string) || value.capturedAt !== undefined ||
      value.freshness !== (value.state === "preserved" ? "preserved" : "captured")) return null;
  const a = value.artifact;
  if (!record(a) || !exactKeys(a, ["version", "snapshotId", "dirId", "engine", "path", "capturedAt", "schema", "semanticHash", "counts", "members", "object"]) ||
      a.version !== 1 || !historyId(a.snapshotId) || a.dirId !== value.dirId || a.engine !== value.engine || !historyTime(a.capturedAt) ||
      value.state !== "preserved" && a.snapshotId !== value.snapshotId || !historyHash(a.semanticHash)) return null;
  const expectedPath = value.engine === "firefox" ? "places.sqlite" : "Default/History";
  if (a.path !== expectedPath || !Array.isArray(a.members) || a.members.length < 1 || a.members.length > 2) return null;
  let bytes = 0;
  for (let i = 0; i < a.members.length; i++) {
    const member = a.members[i];
    if (!record(member) || !exactKeys(member, ["path", "bytes", "sha256"]) || member.path !== expectedPath + (i ? "-wal" : "") || !historyTime(member.bytes) ||
        !i && member.bytes < 512 || !historyHash(member.sha256)) return null;
    bytes += member.bytes;
  }
  const object = a.object, schema = a.schema, counts = a.counts;
  if (bytes > 64 * 1024 * 1024 || !record(object) || !exactKeys(object, ["key", "bytes", "sha256"]) || !historyHash(object.sha256) ||
      object.key !== `history-v1-${object.sha256}.zip` || !historyTime(object.bytes) || object.bytes < bytes || object.bytes > 65 * 1024 * 1024 ||
      !record(schema) || !exactKeys(schema, ["version", "sha256", "userVersion", "applicationId", "metaVersion", "compatibleVersion"]) || schema.version !== 1 || !historyHash(schema.sha256) ||
      !decimal(schema.userVersion) || !decimal(schema.applicationId) || (value.engine === "chromium" ? !decimal(schema.metaVersion) || !decimal(schema.compatibleVersion) : schema.metaVersion !== null || schema.compatibleVersion !== null) ||
      !record(counts) || !exactKeys(counts, ["urls", "visits", "bookmarks"]) || !Object.values(counts).every(decimal)) return null;
  if (value.state !== "preserved" && (value.state === "empty") !== Object.values(counts).every((n) => n === "0")) return null;
  return { ...value, artifact: { ...a, schema: { ...schema } as unknown as HistorySchema, counts: { ...counts },
    object: { ...object }, members: a.members.map((member) => ({ ...member })) } as HistoryArtifact } as unknown as HistoryCoverage;
}
