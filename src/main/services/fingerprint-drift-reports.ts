import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { getAppDataDir, getConfig } from "./config-manager.js";
import { isRestoreLocked } from "./profile-restore-lock.js";
import { sanitizePortableFingerprintBaseline, type Fingerprint } from "./fingerprint-baseline.js";
import type { FingerprintChange, FingerprintDriftAnalysis } from "./fingerprint-drift-policy.js";
import { getProfileDataRevision } from "./profile-data-revision.js";
import { validateDirId } from "./utils.js";
import type { BrowserProfileMeta } from "../types.js";

export interface FingerprintComparisonReport {
  schemaVersion: 1;
  policyVersion: 2;
  id: string;
  dirId: string;
  observedAt: number;
  source: "launch" | "manual" | "baseline";
  hasBaseline: boolean;
  fields: number;
  baselineFields: number;
  availableFields: number;
  comparedFields: number;
  changes: FingerprintChange[];
  counts: { risk: number; review: number; info: number; unavailable: number };
  risky: boolean;
  partial: boolean;
  engine: "chromium" | "firefox";
  engineVersion: string | null;
  baselineCandidate: boolean;
  saved: boolean;
  acceptedAt?: number;
  warning?: string;
}
interface StoredReport { report: FingerprintComparisonReport; witness: string; dataRevision: string }
interface Observation { dirId: string; witness: string; dataRevision: string; routeWitness: string }
interface Candidate extends StoredReport { before: Fingerprint | undefined; snapshot: Fingerprint; observation: object; expiresAt: number }
export interface FingerprintObservation { readonly __fingerprintObservation?: never }
export class FingerprintReportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "FingerprintReportError"; }
}

const MAX_REPORTS = 20;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVATIONS = 128;
const CANDIDATE_TTL_MS = 30 * 60 * 1000;
const observations = new WeakMap<object, Observation>();
const latest = new Map<string, object>();
// Disk reports are evidence for viewing, never authority to accept a baseline.
// Only a snapshot captured by this main-process session can mint a review token.
const candidates = new Map<string, Candidate>();
function filePath(): string {
  const directory = getAppDataDir(), stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new FingerprintReportError("FINGERPRINT_REPORTS_UNAVAILABLE", "Unsafe fingerprint report directory");
  return path.join(directory, "fingerprint-comparisons.json");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}
function proxyWitnessInput(meta: BrowserProfileMeta, config = getConfig(), privateFields = false): unknown {
  const mode = meta.proxyMode || (meta.proxyName ? "named" : "none");
  const selected = mode === "default" ? config.defaultProxy : mode === "named" ? meta.proxyName : null;
  const pending = selected ? [selected] : [], seen = new Set<string>(), definitions: unknown[] = [];
  while (pending.length) {
    const name = pending.shift()!;
    if (seen.has(name)) continue;
    if (seen.size >= 128) throw new FingerprintReportError("FINGERPRINT_ROUTE_WITNESS_UNAVAILABLE", "The selected proxy graph exceeds the review bound.");
    seen.add(name);
    const proxy = config.proxies?.[name];
    definitions.push([name, proxy ? { type: proxy.type, host: proxy.host, port: proxy.port, bypassList: proxy.bypassList || [], fallbacks: proxy.fallbacks || [],
      ...(privateFields ? { username: proxy.username, password: proxy.password } : {}) } : null]);
    pending.push(...(proxy?.fallbacks || []));
  }
  return { mode, selected: selected || null, definitions };
}
const routeHmacKey = randomBytes(32);
function privateRouteWitness(meta: BrowserProfileMeta, config = getConfig()): string {
  return createHmac("sha256", routeHmacKey).update(JSON.stringify(canonical(proxyWitnessInput(meta, config, true)))).digest("hex");
}
/** Main-process-only confirmation binding; never persist or return this value. */
export function fingerprintConfirmationWitness(meta: BrowserProfileMeta): string {
  return createHmac("sha256", routeHmacKey).update(fingerprintProfileWitness(meta)).update(privateRouteWitness(meta)).digest("hex");
}
export function fingerprintProfileWitness(meta: BrowserProfileMeta, config = getConfig()): string {
  const { name, note, tags, updatedAt, syncedAt, syncedHash, syncBaseline, lock, ...identity } = meta;
  // Only public route intent is persisted. Credential-bearing identity uses a
  // random process HMAC exclusively in the in-memory observation/candidate.
  return createHash("sha256").update(JSON.stringify(canonical({ identity, route: proxyWitnessInput(meta, config) }))).digest("hex");
}
function hasRestoreMarker(dirId: string): boolean {
  const directory = path.join(getAppDataDir(), "locks");
  const parent = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!parent) return false;
  if (!parent.isDirectory() || parent.isSymbolicLink()) return true;
  return Boolean(fs.lstatSync(path.join(directory, `${dirId}.restore.lock`), { throwIfNoEntry: false }));
}
function forgetCandidates(dirId: string): void {
  for (const [id, candidate] of candidates) if (candidate.report.dirId === dirId) candidates.delete(id);
}
export function beginFingerprintObservation(dirId: string, meta: BrowserProfileMeta, options: { restoreLockHeld?: boolean; config?: ReturnType<typeof getConfig> } = {}): FingerprintObservation {
  validateDirId(dirId);
  if (!options.restoreLockHeld && isRestoreLocked(dirId)) throw new FingerprintReportError("PROFILE_RESTORE_IN_PROGRESS", "Wait for the data transfer to finish before sampling a reference.");
  const handle = Object.freeze({});
  observations.set(handle, { dirId, witness: fingerprintProfileWitness(meta, options.config), dataRevision: getProfileDataRevision(dirId), routeWitness: privateRouteWitness(meta, options.config) });
  latest.delete(dirId); latest.set(dirId, handle);
  while (latest.size > MAX_OBSERVATIONS) latest.delete(latest.keys().next().value!);
  forgetCandidates(dirId);
  return handle;
}
function isCurrent(handle: FingerprintObservation | undefined, meta: BrowserProfileMeta): boolean {
  const observation = handle && observations.get(handle);
  const current = observation && getConfig().browserProfiles?.[observation.dirId];
  return Boolean(observation && current && latest.get(observation.dirId) === handle &&
    observation.witness === fingerprintProfileWitness(meta) && observation.witness === fingerprintProfileWitness(current) &&
    observation.routeWitness === privateRouteWitness(current) && observation.dataRevision === getProfileDataRevision(observation.dirId));
}
function regularFile(file: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_STORE_BYTES) {
      throw new FingerprintReportError("FINGERPRINT_REPORTS_UNAVAILABLE", "Fingerprint details are not a bounded private regular file.");
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}
function readStore(): StoredReport[] {
  const file = filePath(), before = regularFile(file);
  if (!before) return [];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("Fingerprint report changed before reading");
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count !== before.size) throw new Error("Fingerprint report changed size while reading");
    bytes = buffer.subarray(0, count);
    const after = fs.fstatSync(fd), final = regularFile(file);
    if (bytes.length > MAX_STORE_BYTES || !final || after.ino !== final.ino || after.dev !== final.dev ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error("Fingerprint report changed while reading");
  } finally { fs.closeSync(fd); }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.reports) || parsed.reports.length > MAX_REPORTS) throw new Error("Invalid fingerprint report store");
  return parsed.reports.map((entry: unknown) => parseStored(entry));
}
function parseStored(raw: unknown): StoredReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid fingerprint report record");
  const value = raw as StoredReport, r = value.report;
  if (!r || r.schemaVersion !== 1 || r.policyVersion !== 2 || !/^[0-9a-f-]{36}$/.test(r.id) ||
      typeof r.observedAt !== "number" || !Number.isFinite(r.observedAt) || r.observedAt <= 0 ||
      !["launch", "manual", "baseline"].includes(r.source) || !["chromium", "firefox"].includes(r.engine) ||
      r.engineVersion !== null && (typeof r.engineVersion !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(r.engineVersion)) ||
      typeof r.hasBaseline !== "boolean" || typeof r.risky !== "boolean" || typeof r.partial !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(value.witness) || typeof value.dataRevision !== "string" || value.dataRevision.length > 256 ||
      !Array.isArray(r.changes) || r.changes.length > 512 ||
      [r.fields, r.baselineFields, r.availableFields, r.comparedFields].some(n => !Number.isSafeInteger(n) || n < 0 || n > 4096)) throw new Error("Invalid fingerprint comparison shape");
  validateDirId(r.dirId);
  const counts = { risk: 0, review: 0, info: 0, unavailable: 0 };
  const changes = r.changes.map(change => {
    if (!change || typeof change.field !== "string" || change.field.length > 256 ||
        /[\x00-\x1f\x7f]/.test(change.field) || !permittedField(change.field) ||
        !["identity", "window", "environment", "availability"].includes(change.category) ||
        !Object.hasOwn(counts, change.severity) || typeof change.reason !== "string" || !/^[a-z][a-z-]{0,79}$/.test(change.reason)) throw new Error("Invalid fingerprint difference");
    const baseline = safeValue(change.baseline), current = safeValue(change.current);
    counts[change.severity]++;
    return { field: change.field, baseline, current, category: change.category, severity: change.severity, reason: change.reason,
      ...(change.required === true ? { required: true } : {}),
      ...(change.availability && ["baseline-missing", "probe-unavailable", "invalid"].includes(change.availability) ? { availability: change.availability } : {}),
      ...(change.collectionChange === true ? { collectionChange: true } : {}) };
  });
  const report: FingerprintComparisonReport = {
    schemaVersion: 1, policyVersion: 2, id: r.id, dirId: r.dirId, observedAt: r.observedAt, source: r.source,
    hasBaseline: r.hasBaseline, fields: r.fields, baselineFields: r.baselineFields, availableFields: r.availableFields,
    comparedFields: r.comparedFields, changes, counts, risky: counts.risk > 0, partial: r.partial || counts.unavailable > 0,
    engine: r.engine, engineVersion: r.engineVersion, baselineCandidate: false, saved: true,
    ...(typeof r.acceptedAt === "number" && Number.isFinite(r.acceptedAt) && r.acceptedAt > 0 ? { acceptedAt: r.acceptedAt } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) throw new Error("Fingerprint report exceeds its size bound");
  return { report, witness: value.witness, dataRevision: value.dataRevision };
}
function permittedField(field: string): boolean {
  if (/^persona\.(?:platform|plugins|uaMobile|tz)$/.test(field)) return true;
  const root = field.match(/^([A-Za-z]\w*)(?:[.\[].*)?$/)?.[1];
  return Boolean(root && Object.hasOwn(sanitizePortableFingerprintBaseline({ [root]: "sample" }) || {}, root));
}
function safeValue(value: unknown): unknown {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 128 * 1024) throw new Error("Fingerprint value exceeds its size bound");
  // JSON data only: no getters/functions/prototypes are ever sent to the renderer.
  return JSON.parse(encoded);
}
function writeStore(reports: StoredReport[]): string | undefined {
  while (reports.length > MAX_REPORTS || Buffer.byteLength(JSON.stringify({ schemaVersion: 1, reports })) + 1 > MAX_STORE_BYTES) {
    if (reports.length <= 1) throw new Error("Fingerprint reports exceed the store budget");
    reports.shift();
  }
  const file = filePath(), dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  regularFile(file);
  const temp = file + ".tmp-" + randomUUID();
  let renamed = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, reports }) + "\n", "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    regularFile(file);
    fs.renameSync(temp, file); renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(temp); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("[fingerprint-details] temporary report cleanup failed:", error); }
    }
  }
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    console.warn("[fingerprint-details] report saved but directory sync unconfirmed:", error);
    return "FINGERPRINT_REPORT_DIRECTORY_SYNC_UNCONFIRMED";
  }
}

export function saveFingerprintComparison(handle: FingerprintObservation | undefined, input: {
  dirId: string; meta: BrowserProfileMeta; current: Record<string, unknown>; analysis: FingerprintDriftAnalysis;
  source: FingerprintComparisonReport["source"]; observedAt?: number; engineVersion?: string | null; engine?: "chromium" | "firefox";
  isCurrent?: () => boolean;
  /** Internal only: the caller already acquired the profile's restore lease. */
  restoreLockHeld?: boolean;
}): FingerprintComparisonReport {
  const report: FingerprintComparisonReport = {
    schemaVersion: 1, policyVersion: 2, id: randomUUID(), dirId: input.dirId, observedAt: input.observedAt ?? Date.now(),
    source: input.source, hasBaseline: Boolean(input.meta.fingerprintBaseline), fields: input.analysis.fields,
    baselineFields: input.analysis.baselineFields, availableFields: input.analysis.availableFields, comparedFields: input.analysis.comparedFields,
    changes: input.analysis.changes, counts: input.analysis.counts, risky: input.analysis.risky, partial: input.analysis.partial,
    engine: input.engine || (input.meta.engine === "firefox" ? "firefox" : "chromium"), engineVersion: input.engineVersion || null,
    baselineCandidate: false, saved: false,
  };
  try {
    if (!input.restoreLockHeld && isRestoreLocked(input.dirId) || !isCurrent(handle, input.meta) || input.isCurrent && !input.isCurrent()) throw new FingerprintReportError("FINGERPRINT_REPORT_STALE", "The observed profile changed before details could be saved.");
    const observation = observations.get(handle!)!;
    if (observation.dirId !== input.dirId) throw new FingerprintReportError("FINGERPRINT_REPORT_STALE", "The observation belongs to a different profile.");
    const safe = parseStored({ report, witness: observation.witness, dataRevision: observation.dataRevision });
    // Return exactly the same JSON-safe comparison values that can be reopened.
    report.changes = safe.report.changes; report.counts = safe.report.counts;
    const previous = readStore().filter(entry => entry.report.dirId !== input.dirId);
    if (!input.restoreLockHeld && isRestoreLocked(input.dirId) || !isCurrent(handle, input.meta) || input.isCurrent && !input.isCurrent()) throw new FingerprintReportError("FINGERPRINT_REPORT_STALE", "The observed profile changed before details publication.");
    report.warning = writeStore([...previous, safe]); report.saved = true;
    const snapshot = sanitizePortableFingerprintBaseline(input.current);
    const eligible = snapshot && report.engine === (input.meta.engine === "firefox" ? "firefox" : "chromium") &&
      !input.analysis.blockingUnavailable && !report.changes.some(change => change.field.startsWith("persona."));
    if (eligible) {
      candidates.set(report.id, { ...safe, before: sanitizePortableFingerprintBaseline(input.meta.fingerprintBaseline), snapshot,
        observation: handle!, expiresAt: Date.now() + CANDIDATE_TTL_MS });
      while (candidates.size > MAX_REPORTS) candidates.delete(candidates.keys().next().value!);
      report.baselineCandidate = true;
    }
  } catch (error) {
    report.warning = error instanceof FingerprintReportError ? error.code : "FINGERPRINT_REPORT_SAVE_FAILED";
    console.warn("[fingerprint-details] comparison details not confirmed saved:", error);
  }
  return report;
}
export function readFingerprintComparison(dirId: string, meta: BrowserProfileMeta): {
  report: FingerprintComparisonReport | null; currentConfigMatches: boolean; canUpdateBaseline: boolean;
} {
  validateDirId(dirId);
  const stored = readStore().find(entry => entry.report.dirId === dirId);
  if (!stored) return { report: null, currentConfigMatches: false, canUpdateBaseline: false };
  const trusted = candidates.get(stored.report.id);
  const matches = stored.report.engine === (meta.engine === "firefox" ? "firefox" : "chromium") &&
    stored.witness === fingerprintProfileWitness(meta) && stored.dataRevision === getProfileDataRevision(dirId) &&
    (!trusted || isCurrent(trusted.observation, meta));
  let canUpdateBaseline = false;
  try { getFingerprintBaselineCandidate(dirId, stored.report.id, meta); canUpdateBaseline = true; }
  catch (error) { if (!(error instanceof FingerprintReportError)) throw error; }
  return { report: { ...stored.report, baselineCandidate: canUpdateBaseline }, currentConfigMatches: matches, canUpdateBaseline };
}
export function getFingerprintBaselineCandidate(dirId: string, reportId: string, meta: BrowserProfileMeta, options: { restoreLockHeld?: boolean } = {}): Pick<Candidate, "report" | "before" | "snapshot" | "expiresAt"> {
  validateDirId(dirId);
  if (!options.restoreLockHeld && (isRestoreLocked(dirId, { reclaimStale: false }) || hasRestoreMarker(dirId))) throw new FingerprintReportError("BASELINE_CONFIRMATION_STALE", "Profile data is being restored. Wait for the transfer and observe it again.");
  const candidate = candidates.get(reportId);
  if (!candidate || candidate.report.dirId !== dirId || candidate.expiresAt <= Date.now()) throw new FingerprintReportError("BASELINE_SNAPSHOT_EXPIRED", "The last details remain readable, but a fresh observation is required before updating the reference.");
  if (!isCurrent(candidate.observation, meta) || candidate.witness !== fingerprintProfileWitness(meta) ||
      candidate.dataRevision !== getProfileDataRevision(dirId)) throw new FingerprintReportError("BASELINE_CONFIRMATION_STALE", "The profile or restored data changed after this snapshot. Observe it again.");
  if (candidate.report.changes.some(change => change.field.startsWith("persona."))) throw new FingerprintReportError("BASELINE_IDENTITY_CONFLICT", "The snapshot contradicts the configured identity; fix settings rather than accepting it as a reference.");
  return structuredClone({ report: { ...candidate.report, baselineCandidate: true }, before: candidate.before, snapshot: candidate.snapshot, expiresAt: candidate.expiresAt });
}
export function markFingerprintReferenceAccepted(dirId: string, reportId: string): string | undefined {
  forgetCandidates(dirId);
  const reports = readStore(), stored = reports.find(entry => entry.report.dirId === dirId && entry.report.id === reportId);
  if (!stored) return undefined;
  stored.report.acceptedAt = Date.now();
  return writeStore(reports);
}
export function clearFingerprintComparison(dirId: string): void {
  validateDirId(dirId); latest.delete(dirId); forgetCandidates(dirId);
  const reports = readStore(), retained = reports.filter(entry => entry.report.dirId !== dirId);
  if (retained.length !== reports.length) writeStore(retained);
}
