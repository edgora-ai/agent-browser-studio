// Pure snapshot comparison and policy. No browser, profile store, host identity,
// clock, or launch lookup belongs here; owned launch evidence is an explicit input.
export type FingerprintDrift = {
  field: string;
  baseline: unknown;
  current: unknown;
  availability?: "baseline-missing" | "probe-unavailable" | "invalid";
  /** A previously available, required probe is now unavailable. */
  required?: boolean;
  /** A logical array member changed, not a probe disappearing/being added. */
  collectionChange?: boolean;
};

export type FingerprintChange = FingerprintDrift & {
  category: "identity" | "window" | "environment" | "availability";
  severity: "risk" | "review" | "info" | "unavailable";
  reason: string;
  required?: boolean;
};

export interface FingerprintDriftAnalysis {
  drift: FingerprintDrift[];
  changes: FingerprintChange[];
  counts: { risk: number; review: number; info: number; unavailable: number };
  risky: boolean;
  partial: boolean;
  blockingUnavailable: boolean;
  /** Returned/valid surfaces are top-level probes, not a completeness percentage. */
  fields: number;
  baselineFields: number;
  availableFields: number;
  /** Valid comparable scalar leaves, including semantic JSON identity members. */
  comparedFields: number;
}

const MAX_FIELDS = 256;
const MAX_FIELD_LENGTH = 128;
const MAX_VALUE_LENGTH = 64 * 1024;
const MAX_SNAPSHOT_LENGTH = 256 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 2048;
const MAX_ROWS = 512;
const JSON_FIELDS = new Set(["uaHighEntropy", "workerIdentity", "systemColors"]);
const WINDOW_POSITIONS = new Set(["screenX", "screenY", "screenLeft", "screenTop", "availLeft", "availTop"]);
const WINDOW_DIMENSIONS = new Set(["innerWidth", "innerHeight", "outerWidth", "outerHeight", "availW", "availH", "availWidth", "availHeight"]);
const POSITIVE_NUMBERS = new Set(["screenW", "screenH", "devicePixelRatio", "deviceMemory", "colorDepth", "pixelDepth", "canvasLen"]);
const NONNEGATIVE_INTEGERS = new Set(["maxTouchPoints", "webgpuSubgroupMinSize", "webgpuSubgroupMaxSize"]);
const BOOLEANS = new Set(["mobile", "wow64", "webgpuIsFallbackAdapter"]);
const EMPTY_STRINGS_ALLOWED = new Set([
  "plugins", "mimeTypes", "speechVoices", "mediaDevices", "fontAvailability",
  "webgpuVendor", "webgpuArchitecture", "webgpuDevice", "webgpuDescription",
]);
const IDENTITY_STRINGS = new Set([
  "userAgent", "appVersion", "platform", "language", "languages", "uaPlatform",
  "architecture", "bitness", "platformVersion", "glVendor", "glUnmaskedVendor", "glRenderer",
  ...EMPTY_STRINGS_ALLOWED,
]);
const HASHES = new Set(["canvasHash", "audioHash", "fontCapabilityHash", "webglCapabilityHash", "webgpuCapabilityHash"]);
const ENVIRONMENT_REVIEW = new Set(["mediaDevices", "speechVoices", "doNotTrack", "clientRect"]);
const ENVIRONMENT_INFO = new Set(["preferredColorScheme", "storageQuota", "systemColors"]);
const WORKER_SURFACES = new Set([
  "userAgent", "appVersion", "platform", "language", "languages", "hardwareConcurrency", "deviceMemory",
  "maxTouchPoints", "uaPlatform", "architecture", "bitness", "wow64", "mobile", "tz", "tzOffset",
  "glVendor", "glUnmaskedVendor", "glRenderer",
]);
const VERSION = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

type State = "valid" | "missing" | "unavailable" | "invalid";
type Member = { array: string; path: string };
type Leaf = { field: string; value: unknown; state: State; members: Member[] };
type Probe = {
  root: Leaf;
  leaves: Map<string, Leaf>;
  nodes: Set<string>;
  arrays: Set<string>;
  structured: boolean;
  available: boolean;
  parsed?: Record<string, unknown>;
};
type Comparison = {
  drift: FingerprintDrift[];
  keys: string[];
  baseline: Map<string, Probe>;
  current: Map<string, Probe>;
};

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSystemColor(field: string): boolean {
  return field === "systemColors" || field.startsWith("systemColors.") || field.startsWith("systemColors[");
}

function brandField(field: string): { list: string; brand: string; key: string } | undefined {
  const match = /^uaHighEntropy\.(brands|fullVersionList)\[("(?:[^"\\]|\\.)*")\]\.(brand|version)$/.exec(field);
  if (!match || match[2].length > MAX_FIELD_LENGTH * 2) return undefined;
  try {
    return { list: match[1], brand: JSON.parse(match[2]), key: match[3] };
  } catch {
    return undefined;
  }
}

/** Only known direct identity surfaces receive a known-field policy. */
function surface(field: string): string | undefined {
  if (field.startsWith("workerIdentity.")) {
    const child = field.slice("workerIdentity.".length);
    return WORKER_SURFACES.has(child) ? child : undefined;
  }
  if (field.startsWith("uaHighEntropy.")) {
    const child = field.slice("uaHighEntropy.".length);
    if (["architecture", "bitness", "wow64", "mobile", "platform", "platformVersion", "uaFullVersion", "brands", "fullVersionList"].includes(child)) return child;
    const brand = brandField(field);
    return brand ? (brand.key === "version" ? "brandVersion" : "brandName") : undefined;
  }
  return /^[A-Za-z][A-Za-z0-9]*$/.test(field) ? field : undefined;
}

function scalarState(field: string, value: unknown): State {
  const key = surface(field);
  if (key === "doNotTrack" && value === null) return "valid"; // Explicitly unset, not a failed API.
  if (value === null && ["uaPlatform", "glRenderer", "glUnmaskedVendor"].includes(key || "")) return "unavailable";
  if (value === null || value === undefined) return "invalid";
  if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) return "invalid";
  if (isSystemColor(field) && field !== "systemColors") return typeof value === "string" && value.trim() !== "" ? "valid" : "invalid";
  if (WINDOW_POSITIONS.has(key || "")) return typeof value === "number" && Number.isFinite(value) ? "valid" : "invalid";
  if (WINDOW_DIMENSIONS.has(key || "") || POSITIVE_NUMBERS.has(key || "")) return typeof value === "number" && Number.isFinite(value) && value > 0 ? "valid" : "invalid";
  if (key === "hardwareConcurrency") return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? "valid" : "invalid";
  if (NONNEGATIVE_INTEGERS.has(key || "")) return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? "valid" : "invalid";
  if (key === "storageQuota") return typeof value === "number" && Number.isFinite(value) && value >= 0 ? "valid" : "invalid";
  if (key === "tzOffset") return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 1440 ? "valid" : "invalid";
  if (BOOLEANS.has(key || "")) return typeof value === "boolean" ? "valid" : "invalid";
  if (key === "preferredColorScheme") return ["light", "dark", "no-preference"].includes(value as string) ? "valid" : "invalid";
  if (key === "tz") {
    if (typeof value !== "string" || value.trim() !== value || !value) return "invalid";
    try {
      // Explicit zone validation only; never consult the host zone or current date.
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return "valid";
    } catch {
      return "invalid";
    }
  }
  if (key === "clientRect") {
    if (typeof value !== "string" || value.trim() === "") return "invalid";
    const parts = value.split(",");
    return parts.length === 4 && parts.every((part) => part.trim() !== "" && Number.isFinite(Number(part))) &&
      Number(parts[2]) >= 0 && Number(parts[3]) >= 0 ? "valid" : "invalid";
  }
  if (key === "brandVersion" || key === "uaFullVersion") return typeof value === "string" && VERSION.test(value) ? "valid" : "invalid";
  if (key === "brands" || key === "fullVersionList") return Array.isArray(value) && value.length === 0 ? "valid" : "invalid";
  if (key === "brandName") return typeof value === "string" && value.trim() !== "" ? "valid" : "invalid";
  if (IDENTITY_STRINGS.has(key || "") || HASHES.has(key || "")) {
    return typeof value === "string" && (EMPTY_STRINGS_ALLOWED.has(key || "") || value.trim() !== "") ? "valid" : "invalid";
  }
  if (key === "doNotTrack") return typeof value === "string" && value.trim() !== "" ? "valid" : "invalid";
  // Unknown scalar values are retained and compared, never silently ignored.
  if (typeof value === "number") return Number.isFinite(value) ? "valid" : "invalid";
  if (typeof value === "string" || typeof value === "boolean") return "valid";
  // Empty JSON containers are semantic leaves; arbitrary top-level objects are not.
  return "invalid";
}

function requiredField(field: string): boolean {
  if (field === "workerIdentity" || field.startsWith("workerIdentity.")) return false;
  const key = surface(field);
  if (ENVIRONMENT_INFO.has(key || "") || ENVIRONMENT_REVIEW.has(key || "") || isSystemColor(field)) return false;
  return field === "uaHighEntropy" || field.startsWith("uaHighEntropy.") ||
    WINDOW_POSITIONS.has(key || "") || WINDOW_DIMENSIONS.has(key || "") ||
    POSITIVE_NUMBERS.has(key || "") || NONNEGATIVE_INTEGERS.has(key || "") || BOOLEANS.has(key || "") ||
    IDENTITY_STRINGS.has(key || "") || HASHES.has(key || "") || ["hardwareConcurrency", "tz", "tzOffset"].includes(key || "");
}

function scalarProbe(field: string, value: unknown, state: State): Probe {
  const root: Leaf = { field, value, state, members: [] };
  return { root, leaves: new Map([[field, root]]), nodes: new Set([field]), arrays: new Set(), structured: false, available: state === "valid" };
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function probe(field: string, value: unknown, present: boolean): Probe {
  if (!present) return scalarProbe(field, undefined, "missing");
  if (!JSON_FIELDS.has(field)) return scalarProbe(field, value, scalarState(field, value));
  if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return scalarProbe(field, value, "invalid");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed) || Object.keys(parsed).length === 0) return scalarProbe(field, value, "invalid");
    if (parsed.timeout === true || parsed.error === true || (typeof parsed.error === "string" && parsed.error.trim() !== "") ||
        parsed.unsupported === true || parsed.supported === false) return scalarProbe(field, value, "unavailable");
    const result: Probe = {
      root: { field, value, state: "valid", members: [] }, leaves: new Map(), nodes: new Set(), arrays: new Set(),
      structured: true, available: true, parsed,
    };
    let nodes = 0;
    function visit(node: unknown, path: string, depth: number, members: Member[]): void {
      if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new RangeError("Fingerprint JSON exceeds complexity limit");
      result.nodes.add(path);
      const key = surface(path);
      const knownScalar = IDENTITY_STRINGS.has(key || "") || HASHES.has(key || "") || BOOLEANS.has(key || "") ||
        POSITIVE_NUMBERS.has(key || "") || NONNEGATIVE_INTEGERS.has(key || "") ||
        ["hardwareConcurrency", "tz", "tzOffset", "brandVersion", "brandName", "uaFullVersion"].includes(key || "");
      if (knownScalar && node !== null && typeof node === "object") {
        result.available = false;
        result.root.state = "invalid";
        result.leaves.set(path, { field: path, value: node, state: "invalid", members });
        return;
      }
      if (Array.isArray(node)) {
        result.arrays.add(path);
        const branded = path === "uaHighEntropy.brands" || path === "uaHighEntropy.fullVersionList";
        const brands = new Set<string>();
        for (let index = 0; index < node.length; index++) {
          const item = node[index];
          let memberPath = `${path}[${index}]`;
          if (branded) {
            if (!record(item) || typeof item.brand !== "string" || !item.brand.trim() || item.brand.length > MAX_FIELD_LENGTH ||
                typeof item.version !== "string" || !VERSION.test(item.version)) throw new TypeError("Invalid UA brand entry");
            const logicalBrand = item.brand.trim().toLowerCase();
            if (brands.has(logicalBrand)) throw new TypeError("Duplicate UA brand");
            brands.add(logicalBrand);
            memberPath = `${path}[${JSON.stringify(item.brand)}]`;
          }
          visit(item, memberPath, depth + 1, [...members, { array: path, path: memberPath }]);
        }
        if (node.length > 0) return;
      } else if (record(node)) {
        const keys = Object.keys(node);
        for (const key of keys) {
          if (key.length > MAX_FIELD_LENGTH) throw new RangeError("Fingerprint JSON key exceeds size limit");
          // These two known properties must be brand arrays, not objects/scalars.
          if (path === "uaHighEntropy" && ["brands", "fullVersionList"].includes(key) && !Array.isArray(node[key])) {
            throw new TypeError("Invalid UA brand list");
          }
          visit(node[key], propertyPath(path, key), depth + 1, members);
        }
        if (keys.length > 0) return;
      }
      const emptyContainer = (Array.isArray(node) && node.length === 0) || (record(node) && Object.keys(node).length === 0);
      const state = emptyContainer && !knownScalar && !isSystemColor(path) ? "valid" : scalarState(path, node);
      if (state !== "valid") {
        result.available = false;
        result.root.state = state === "invalid" || result.root.state === "invalid" ? "invalid" : "unavailable";
      }
      result.leaves.set(path, { field: path, value: node, state, members });
    }
    visit(parsed, field, 0, []);
    return result;
  } catch {
    // Malformed, oversized, too-deep, duplicate-brand and wrong-shape JSON are
    // explicit unavailable evidence, including when both captures are identical.
    return scalarProbe(field, value, "invalid");
  }
}

function snapshotProbes(snapshot: Record<string, unknown> | null | undefined): Map<string, Probe> {
  if (snapshot == null) return new Map();
  if (!record(snapshot)) throw new TypeError("Invalid fingerprint snapshot");
  const keys = Object.keys(snapshot);
  if (keys.length > MAX_FIELDS) throw new RangeError("Fingerprint snapshot exceeds field limit");
  const result = new Map<string, Probe>();
  let length = 0;
  for (const key of keys) {
    if (!key || key.length > MAX_FIELD_LENGTH) throw new RangeError("Fingerprint field name exceeds size limit");
    const value = snapshot[key];
    length += key.length + (typeof value === "string" ? value.length : 8);
    if (length > MAX_SNAPSHOT_LENGTH) throw new RangeError("Fingerprint snapshot exceeds size limit");
    result.set(key, probe(key, value, true));
  }
  return result;
}

function leafEqual(baseline: unknown, current: unknown): boolean {
  if (baseline === current) return true;
  if (Array.isArray(baseline) && Array.isArray(current)) return baseline.length === 0 && current.length === 0;
  return record(baseline) && record(current) && Object.keys(baseline).length === 0 && Object.keys(current).length === 0;
}

function missingLeaf(field: string): Leaf {
  return { field, value: undefined, state: "missing", members: [] };
}

function driftRow(baseline: Leaf, current: Leaf, collectionChange = false): FingerprintDrift | undefined {
  if (baseline.state === "valid" && current.state === "valid" && leafEqual(baseline.value, current.value)) return undefined;
  const row: FingerprintDrift = { field: baseline.field, baseline: baseline.value, current: current.value };
  if (collectionChange && [baseline.state, current.state].includes("valid") && [baseline.state, current.state].includes("missing")) {
    row.collectionChange = true;
    return row;
  }
  if (baseline.state !== "valid" || current.state !== "valid") {
    row.availability = baseline.state === "missing" && current.state === "valid" ? "baseline-missing" :
      baseline.state === "invalid" || current.state === "invalid" ? "invalid" : "probe-unavailable";
    if (baseline.state === "valid" && current.state !== "valid" && requiredField(row.field)) row.required = true;
  }
  return row;
}

function comparison(baseline: Record<string, unknown> | null | undefined, current: Record<string, unknown>): Comparison {
  if (!record(current)) throw new TypeError("Invalid current fingerprint snapshot");
  const before = snapshotProbes(baseline);
  const after = snapshotProbes(current);
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const drift: FingerprintDrift[] = [];
  const paths = new Set<string>();
  function append(row: FingerprintDrift | undefined): void {
    if (!row) return;
    if (drift.length >= MAX_ROWS) throw new RangeError("Fingerprint drift exceeds row limit");
    if (paths.has(row.field)) throw new TypeError("Ambiguous fingerprint field path");
    paths.add(row.field);
    drift.push(row);
  }
  for (const field of keys) {
    const b = before.get(field) || probe(field, undefined, false);
    const c = after.get(field) || probe(field, undefined, false);
    if (field.startsWith("persona.")) {
      // Persona conflicts supplied by a caller can never become a confirmation candidate.
      append({ field, baseline: b.root.value, current: c.root.value });
    } else if (b.structured && c.structured) {
      for (const path of new Set([...b.leaves.keys(), ...c.leaves.keys()])) {
        const bl = b.leaves.get(path) || missingLeaf(path);
        const cl = c.leaves.get(path) || missingLeaf(path);
        // An empty-array leaf is a placeholder, not a newly added/missing probe.
        // Its member additions/removals below already describe the entire change.
        if (b.arrays.has(path) && c.arrays.has(path) && (bl.state === "missing" || cl.state === "missing")) continue;
        const missing = bl.state === "missing" ? b : cl.state === "missing" ? c : undefined;
        const present = bl.state === "missing" ? cl : bl;
        const memberChanged = !!missing && present.members.some((member) =>
          b.arrays.has(member.array) && c.arrays.has(member.array) && !missing.nodes.has(member.path));
        append(driftRow(bl, cl, memberChanged));
      }
    } else {
      append(driftRow(b.root, c.root));
    }
  }
  if (keys.length === 0) {
    append({ field: "$snapshot", baseline, current, availability: baseline == null ? "baseline-missing" : "probe-unavailable" });
  }
  return { drift, keys, baseline: before, current: after };
}

/** Semantic, type-preserving diff; invalid/unsupported probes are never an empty success. */
export function diffFingerprintSnapshots(
  baseline: Record<string, unknown> | null | undefined,
  current: Record<string, unknown>,
): FingerprintDrift[] {
  return comparison(baseline, current).drift;
}

/** Conservative row-only policy: no browser-update or host/environment inference. */
export function classifyFingerprintDrift(row: FingerprintDrift): FingerprintChange {
  const change = (category: FingerprintChange["category"], severity: FingerprintChange["severity"], reason: string): FingerprintChange =>
    ({ ...row, category, severity, reason });
  if (row.field.startsWith("persona.")) return change("identity", "risk", "identity-changed");
  let availability = row.availability;
  if (!availability) {
    const b = row.baseline === undefined ? "missing" : probe(row.field, row.baseline, true).root.state;
    const c = row.current === undefined ? "missing" : probe(row.field, row.current, true).root.state;
    if (!(row.collectionChange && (b === "missing" || c === "missing") && (b === "valid" || c === "valid"))) {
      if (b !== "valid" || c !== "valid") {
        availability = b === "missing" && c === "valid" ? "baseline-missing" : b === "invalid" || c === "invalid" ? "invalid" : "probe-unavailable";
        row = { ...row, availability, ...(b === "valid" && c !== "valid" && requiredField(row.field) ? { required: true } : {}) };
      }
    }
  }
  if (availability) return availability === "baseline-missing" ? change("availability", "review", "baseline-missing") : change("availability", "unavailable", "probe-unavailable");
  const key = surface(row.field);
  if (WINDOW_POSITIONS.has(key || "") || WINDOW_DIMENSIONS.has(key || "")) return change("window", "info", "window-geometry");
  if (isSystemColor(row.field) || key === "preferredColorScheme") return change("environment", "info", "display-environment");
  if (key === "storageQuota") return change("environment", "info", "runtime-environment");
  if (ENVIRONMENT_REVIEW.has(key || "")) return change("environment", "review", "runtime-environment");
  // No baseline capture date is in the snapshot contract. Even with observedAt,
  // an offset-only difference cannot honestly be attributed to DST.
  if (key === "tzOffset") return change("environment", "review", "timezone-offset");
  if (HASHES.has(key || "")) return change("identity", "risk", "opaque-signal-change");
  if (JSON_FIELDS.has(row.field) || IDENTITY_STRINGS.has(key || "") || POSITIVE_NUMBERS.has(key || "") ||
      NONNEGATIVE_INTEGERS.has(key || "") || BOOLEANS.has(key || "") ||
      ["tz", "hardwareConcurrency", "brandVersion", "brandName", "uaFullVersion", "brands", "fullVersionList"].includes(key || "")) {
    return change("identity", "risk", "identity-changed");
  }
  return change("identity", "review", "unknown-field");
}

type BrowserToken = { product: string; version: string; skeleton: string };
function browserToken(value: unknown): BrowserToken | undefined {
  if (typeof value !== "string") return undefined;
  const matches = [...value.matchAll(/\b(HeadlessChrome|Chrome|Chromium|Firefox)\/(\d{1,6}(?:\.\d{1,6}){1,3})(?=$|[\s;)])/g)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  return { product: match[1], version: match[2], skeleton: value.slice(0, match.index) + match[1] + "/<version>" + value.slice(match.index! + match[0].length) };
}

function engineBrand(brand: string): boolean {
  // GREASE and unknown brands are deliberately not normalized or waived.
  return brand === "Chromium" || brand === "Google Chrome" || brand === "HeadlessChrome";
}

function versionEvidence(current: Record<string, unknown>, probes: Map<string, Probe>, expected: string | null | undefined): boolean {
  if (typeof expected !== "string" || !VERSION.test(expected) || !expected.includes(".")) return false;
  const ua = browserToken(current.userAgent);
  if (!ua) return false;
  const major = expected.split(".")[0];
  const reduced = `${major}.0.0.0`;
  if (ua.version !== expected && ua.version !== reduced) return false;
  const he = probes.get("uaHighEntropy");
  if (!he) {
    // Missing evidence is not proof of an unsupported API. The capture uses an
    // explicit null for unsupported UA Client Hints.
    return current.uaPlatform === null && ua.version === expected;
  }
  if (!he.available || !he.parsed || ua.product === "Firefox") return false;
  const full = he.parsed.fullVersionList;
  if (!Array.isArray(full)) return false;
  const known = full.filter((item) => record(item) && typeof item.brand === "string" && engineBrand(item.brand));
  if (!known.length || !known.every((item) => item.version === expected)) return false;
  const brands = he.parsed.brands;
  if (Array.isArray(brands) && !brands.every((item) => !record(item) || typeof item.brand !== "string" || !engineBrand(item.brand) || item.version === major)) return false;
  return he.parsed.uaFullVersion === undefined || he.parsed.uaFullVersion === expected;
}

function versionOnly(row: FingerprintDrift, current: Record<string, unknown>, expected: string): boolean {
  if (row.availability || row.collectionChange) return false;
  if (["userAgent", "appVersion", "workerIdentity.userAgent", "workerIdentity.appVersion"].includes(row.field)) {
    const b = browserToken(row.baseline);
    const c = browserToken(row.current);
    if (!b || !c || b.skeleton !== c.skeleton || b.version === c.version) return false;
    if (c.version !== expected && c.version !== `${expected.split(".")[0]}.0.0.0`) return false;
    if (row.field === "workerIdentity.userAgent" && row.current !== current.userAgent) return false;
    return true;
  }
  if (row.field === "uaHighEntropy.uaFullVersion") return typeof row.baseline === "string" && VERSION.test(row.baseline) && row.current === expected;
  const brand = brandField(row.field);
  return !!brand && brand.key === "version" && engineBrand(brand.brand) && typeof row.baseline === "string" && VERSION.test(row.baseline) &&
    row.current === (brand.list === "fullVersionList" ? expected : expected.split(".")[0]);
}

export function analyzeFingerprintDrift(
  baseline: Record<string, unknown> | null | undefined,
  current: Record<string, unknown>,
  drift: FingerprintDrift[],
  options?: { expectedBrowserVersion?: string | null; observedAt?: number },
): FingerprintDriftAnalysis {
  const compared = comparison(baseline, current);
  if (drift.length > MAX_ROWS) throw new RangeError("Fingerprint drift exceeds row limit");
  // Re-derive coverage and missing probes from the snapshots, even if a legacy
  // caller passes an empty diff. Preserve caller-added persona/unknown evidence.
  const rows = new Map(compared.drift.map((row) => [row.field, row]));
  for (const row of drift) {
    // Legacy whole-JSON rows with these exact source bytes are redundant with
    // the semantic comparison, including key/brand reordering with no drift.
    if (JSON_FIELDS.has(row.field) && compared.baseline.has(row.field) && compared.current.has(row.field) &&
        compared.baseline.get(row.field)!.root.value === row.baseline && compared.current.get(row.field)!.root.value === row.current) continue;
    if (!rows.has(row.field)) rows.set(row.field, row);
    if (rows.size > MAX_ROWS) throw new RangeError("Fingerprint drift exceeds row limit");
  }
  const proof = versionEvidence(current, compared.current, options?.expectedBrowserVersion);
  const changes = [...rows.values()].map((row) => {
    const classified = classifyFingerprintDrift(row);
    if (classified.severity === "risk" && proof && versionOnly(row, current, options!.expectedBrowserVersion!)) {
      return { ...classified, severity: "review" as const, reason: "browser-version" };
    }
    if (row.availability === "baseline-missing" && baseline != null && compared.baseline.size > 0) {
      return { ...classified, reason: "probe-added" };
    }
    return classified;
  });
  const counts = { risk: 0, review: 0, info: 0, unavailable: 0 };
  for (const change of changes) counts[change.severity]++;
  const availableFields = [...compared.current.values()].filter((sample) => sample.available).length;
  const comparedFields = compared.keys.reduce((count, field) => {
    const before = compared.baseline.get(field), after = compared.current.get(field);
    if (!before?.available || !after?.available) return count;
    return count + [...before.leaves].filter(([key, leaf]) => leaf.state === "valid" && after.leaves.get(key)?.state === "valid").length;
  }, 0);
  return {
    drift: [...rows.values()], changes, counts, risky: counts.risk > 0,
    partial: counts.unavailable > 0 || changes.some((change) => change.availability === "baseline-missing") ||
      !compared.keys.some(field => compared.baseline.get(field)?.available && compared.current.get(field)?.available),
    blockingUnavailable: changes.some((change) => change.severity === "unavailable" && change.required === true),
    fields: compared.current.size, baselineFields: compared.baseline.size, availableFields, comparedFields,
  };
}

/** Confirmation fence: only semantic equality or normal informational changes. */
export function isFingerprintSnapshotEquivalent(
  reviewed: Record<string, unknown> | null | undefined,
  current: Record<string, unknown>,
): boolean {
  try {
    const analysis = analyzeFingerprintDrift(reviewed, current, []);
    return reviewed != null && !analysis.partial && analysis.comparedFields > 0 &&
      analysis.counts.risk === 0 && analysis.counts.review === 0 && analysis.counts.unavailable === 0;
  } catch {
    // Invalid/overflowing evidence is never a confirmation candidate.
    return false;
  }
}
