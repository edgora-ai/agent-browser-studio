import { createHash } from "node:crypto";
import type { BrowserProfileMeta } from "../types.js";
import { portableProfileContent } from "./config-manager.js";
import type { PortableProfileContent } from "./profile-portability.js";

/** Saved identity intent, NOT a browser-observed fingerprint or launch receipt.
 * Keep this separate from the broader sync content hash (names, notes, etc.).
 * Never add proxy objects/names, URLs, local paths or baseline bodies here. */
export const PROFILE_IDENTITY_FIELDS = [
  "fingerprintSeed", "fingerprintMode", "engine", "browserVersion", "platform",
  "timezone", "locale", "webrtcMode", "webrtcIp", "geolocationMode",
  "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy",
  "gpuVendor", "gpuRenderer", "hardwareConcurrency", "deviceMemory",
  "screenWidth", "screenHeight", "storageQuota", "taskbarHeight", "renderScaleMode",
  "allowThirdPartyCookies", "drm", "extensions",
] as const satisfies readonly (keyof BrowserProfileMeta)[];
export type ProfileIdentityField = typeof PROFILE_IDENTITY_FIELDS[number];
export type ProfileIdentityConfiguration = Required<Pick<PortableProfileContent, ProfileIdentityField>>;
export type ProfileConfigurationIdentityState = "retained" | "changed" | "not-verifiable" | "missing-seed";
export type ProfileRuntimeIdentityState = "not-verified" | "reverified" | "different" | "not-verifiable";

export const PROFILE_IDENTITY_LIMITATIONS = [
  "Configuration retention does not prove runtime fingerprint equivalence or that the current engine accepts the configuration.",
  "browserVersion is a requested pin (null means auto), not an observed executable version; UA and capabilities depend on the actual engine and launch policy.",
  "Custom font directories and host system fonts are device-local; their files and rendered metrics are not proved by this hash.",
  "Extension references do not prove installed package bytes, version, availability or execution; ZIP backups omit repository packages.",
  "Host OS, GPU capabilities, display/raster scale and engine-specific policies can change runtime identity even with the same seed.",
  "Proxy credentials/routes, automatic exit-IP/timezone resolution and global DNS policy are deliberately outside this configuration hash.",
] as const;

export interface ProfileIdentityDescription {
  version: 1;
  scope: "profile-identity-configuration";
  state: "available" | "missing-seed" | "not-verifiable";
  hash: string | null;
  configuration: ProfileIdentityConfiguration | null;
  seedState: "present" | "missing" | "invalid";
  /** Presence only. Never inspect, hash, or promote imported baseline content. */
  retainedBaseline: boolean;
  invalidFields: string[];
  limitations: readonly string[];
}
export interface ProfileIdentityChange {
  field: ProfileIdentityField;
  before: ProfileIdentityConfiguration[ProfileIdentityField];
  after: ProfileIdentityConfiguration[ProfileIdentityField];
}
export interface ProfileIdentityComparison {
  version: 1;
  configuration: {
    state: ProfileConfigurationIdentityState;
    beforeHash: string | null;
    afterHash: string | null;
    changes: ProfileIdentityChange[];
    reasons: string[];
  };
  runtime: {
    state: "not-verified";
    reason: "no-live-comparison" | "retained-baseline-is-not-runtime-proof";
  };
  limitations: readonly string[];
}

const MODES: Partial<Record<ProfileIdentityField, readonly string[]>> = {
  fingerprintMode: ["managed", "off"], engine: ["chromium", "firefox"],
  platform: ["windows", "macos", "android"], webrtcMode: ["auto", "real", "altered", "disable"],
  geolocationMode: ["real", "disable", "custom"], renderScaleMode: ["native", "strict"],
};
const NUMERIC_FIELDS = new Set<ProfileIdentityField>([
  "geolocationLatitude", "geolocationLongitude", "geolocationAccuracy", "hardwareConcurrency",
  "deviceMemory", "screenWidth", "screenHeight", "storageQuota", "taskbarHeight",
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(value));
}
function validField(field: ProfileIdentityField, value: unknown): boolean {
  if (field === "fingerprintSeed") return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 999999;
  if (value === undefined) return true;
  if (field === "extensions") {
    if (!record(value) || Object.keys(value).length > 200) return false;
    return Object.keys(value).every((key) => {
      const entry = Object.getOwnPropertyDescriptor(value, key);
      return /^(?:[a-p]{32}|local_[a-z0-9]{8,40})$/.test(key) && entry !== undefined &&
        "value" in entry && typeof entry.value === "boolean";
    });
  }
  if (field === "drm" || field === "allowThirdPartyCookies") return value === null || typeof value === "boolean";
  if (NUMERIC_FIELDS.has(field)) return value === null || value === "" || typeof value === "number" && Number.isFinite(value);
  const modes = MODES[field];
  if (modes) return value === null || value === "" || typeof value === "string" && modes.includes(value);
  return value === null || typeof value === "string";
}

/** Call on the original profile from the archive/envelope, BEFORE getProfileMeta,
 * portableProfileContent or import normalization fills a legacy missing seed.
 * Reuses production default semantics without inspecting any excluded field.
 * This module must not be imported by config-manager (it uses its normalizer). */
export function describeProfileIdentity(raw: unknown): ProfileIdentityDescription {
  const base = { version: 1 as const, scope: "profile-identity-configuration" as const,
    hash: null, configuration: null, retainedBaseline: false, limitations: PROFILE_IDENTITY_LIMITATIONS };
  if (!record(raw)) return { ...base, state: "not-verifiable", seedState: "invalid", invalidFields: ["profile"] };
  const baseline = Object.getOwnPropertyDescriptor(raw, "fingerprintBaseline");
  const retainedBaseline = baseline !== undefined && (!Object.hasOwn(baseline, "value") || baseline.value != null);
  const selected: Record<string, unknown> = { name: "identity" };
  const invalidFields: string[] = [];
  let seedState: ProfileIdentityDescription["seedState"] = "missing";
  for (const field of PROFILE_IDENTITY_FIELDS) {
    const entry = Object.getOwnPropertyDescriptor(raw, field);
    if (entry && !("value" in entry)) { invalidFields.push(field); if (field === "fingerprintSeed") seedState = "invalid"; continue; }
    const value: unknown = entry?.value;
    if (field === "fingerprintSeed" && value === undefined) continue;
    if (!validField(field, value)) { invalidFields.push(field); if (field === "fingerprintSeed") seedState = "invalid"; continue; }
    selected[field] = value;
    if (field === "fingerprintSeed") seedState = "present";
  }
  const observed = { ...base, retainedBaseline, seedState, invalidFields };
  if (invalidFields.length) return { ...observed, state: "not-verifiable" };
  if (seedState === "missing") return { ...observed, state: "missing-seed" };
  let normalized: PortableProfileContent;
  try { normalized = portableProfileContent(selected); }
  catch {
    // The production validator may mention raw values. Never echo those into
    // transport/UI diagnostics or turn invalid metadata into a retained hash.
    return { ...observed, state: "not-verifiable", invalidFields: ["identity-values"] };
  }
  const configuration = Object.fromEntries(PROFILE_IDENTITY_FIELDS.map((field) => [field, normalized[field]])) as ProfileIdentityConfiguration;
  const hash = createHash("sha256").update(canonical({ version: 1, scope: base.scope, configuration })).digest("hex");
  return { ...observed, state: "available", configuration, hash };
}

/** Equality is limited to saved configuration. It never generates a seed,
 * changes the supplied objects, or treats a copied baseline as a live retest. */
export function compareProfileIdentity(before: unknown, after: unknown): ProfileIdentityComparison {
  const left = describeProfileIdentity(before), right = describeProfileIdentity(after);
  const changes: ProfileIdentityChange[] = [];
  const reasons: string[] = [];
  for (const [side, description] of [["before", left], ["after", right]] as const) {
    if (description.state === "missing-seed") reasons.push(`${side}:missing-seed`);
    if (description.state === "not-verifiable") reasons.push(`${side}:invalid-identity`);
  }
  let state: ProfileConfigurationIdentityState;
  if (left.state === "not-verifiable" || right.state === "not-verifiable") state = "not-verifiable";
  else if (left.state === "missing-seed" || right.state === "missing-seed") state = "missing-seed";
  else {
    state = left.hash === right.hash ? "retained" : "changed";
    for (const field of PROFILE_IDENTITY_FIELDS) {
      const before = left.configuration![field], after = right.configuration![field];
      if (canonical(before) !== canonical(after)) changes.push({ field, before, after });
    }
  }
  return {
    version: 1, configuration: { state, beforeHash: left.hash, afterHash: right.hash, changes, reasons },
    runtime: { state: "not-verified", reason: left.retainedBaseline || right.retainedBaseline
      ? "retained-baseline-is-not-runtime-proof" : "no-live-comparison" },
    limitations: PROFILE_IDENTITY_LIMITATIONS,
  };
}
