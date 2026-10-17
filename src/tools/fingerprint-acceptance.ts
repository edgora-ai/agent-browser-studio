import type { BrowserFingerprintConfig } from "../main/services/browser-fingerprint-config.js";

/**
 * Static acceptance ledger, not a probe runner. No browser, file or process is
 * opened here. The runner must perform the assertions and verify artifact bytes,
 * hashes, executable/profile provenance and any native-control relationship.
 * This module validates their recorded shape/binding and keeps the denominator.
 * An eligible receipt covers only its exact lane/profile/config/run, not other
 * hosts, engines, modes, physical hardware identity or third-party scores.
 */
export const FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION = 1;
export const FINGERPRINT_PROBE_MANIFEST_VERSION = "fingerprint-acceptance/1";

export type ProbeStatus = "PASS" | "FAIL" | "BLOCKED" | "NOTRUN" | "UNSUPPORTED";
export interface ProbeLane {
  readonly hostPlatform: "darwin" | "win32";
  readonly engine: "chromium" | "firefox";
  readonly mode: "headed" | "headless";
  readonly identityMode: "managed" | "native";
}
export type ProbeContext =
  | "config" | "launch" | "runtime" | "window"
  | "dedicated-worker" | "shared-worker" | "service-worker"
  | "same-origin-frame" | "cross-origin-frame"
  | "http-window" | "http-dedicated-worker" | "http-shared-worker" | "http-service-worker"
  | "http-same-origin-frame" | "http-cross-origin-frame"
  | "native-control" | "restart-same-seed" | "restart-new-seed" | "second-profile"
  | "proxy" | "dns";
export type ProbeSupport =
  | { readonly status: "SUPPORTED" }
  | { readonly status: "UNSUPPORTED"; readonly reason: string };
export interface ProbeSpec {
  readonly id: string;
  readonly name: string;
  readonly contract: string;
  readonly configFields: readonly (keyof BrowserFingerprintConfig)[];
  readonly contexts: readonly ProbeContext[];
  readonly evidenceKind: "capture" | "full-identity-assertions";
  readonly required: boolean;
  readonly support: ProbeSupport;
}
export interface ProbeManifest {
  readonly schemaVersion: typeof FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION;
  readonly manifestVersion: typeof FINGERPRINT_PROBE_MANIFEST_VERSION;
  readonly lane: ProbeLane;
  readonly probes: readonly ProbeSpec[];
}

/** sourceSha256 is a digest of the actual source input, including dirty files. */
export interface EvidenceBinding extends ProbeLane {
  readonly schemaVersion: typeof FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION;
  readonly manifestVersion: typeof FINGERPRINT_PROBE_MANIFEST_VERSION;
  readonly sourceRevision: string;
  readonly sourceDirty: boolean;
  readonly sourceSha256: string;
  readonly binarySha256: string;
  readonly configSha256: string;
  readonly runId: string;
  readonly hostId: string;
  readonly profileId: string;
}
export interface EvidenceReference {
  readonly id: string;
  readonly probeId: string;
  readonly kind: "capture" | "full-identity-assertions" | "prerequisite";
  readonly context: ProbeContext | "prerequisite";
  readonly artifact: string;
  readonly locator: string;
  readonly sha256: string;
  /** Binds the acceptance subject; the runner also verifies comparison subjects. */
  readonly binding: EvidenceBinding;
}
export type ProbeValue = null | boolean | number | string
  | readonly ProbeValue[] | { readonly [key: string]: ProbeValue };
export interface ProbeCheck {
  readonly id: string;
  readonly context: ProbeContext;
  readonly passed: boolean;
  readonly expected: ProbeValue;
  readonly actual: ProbeValue;
  readonly evidenceIds: readonly string[];
  readonly reason?: string;
}
export interface ProbeResult {
  readonly id: string;
  readonly status: ProbeStatus;
  readonly reason?: string;
  readonly timedOut?: boolean;
  readonly checks?: readonly ProbeCheck[];
  readonly evidence?: readonly EvidenceReference[];
  readonly blocker?: {
    readonly prerequisite: string;
    readonly evidenceIds: readonly string[];
  };
}
export interface AcceptanceProbeResult extends ProbeResult {
  readonly name: string;
  readonly required: boolean;
  readonly support: ProbeSupport;
  readonly checks: readonly ProbeCheck[];
  readonly evidence: readonly EvidenceReference[];
}
export interface AcceptanceSummary {
  readonly schemaVersion: typeof FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION;
  readonly manifestVersion: typeof FINGERPRINT_PROBE_MANIFEST_VERSION;
  readonly binding: EvidenceBinding;
  readonly results: readonly AcceptanceProbeResult[];
  readonly totals: Readonly<Record<ProbeStatus, number> & {
    total: number;
    supported: number;
    required: number;
    requiredPassed: number;
  }>;
  readonly eligible: boolean;
}

const NAVIGATORS: readonly ProbeContext[] = [
  "window", "dedicated-worker", "shared-worker", "service-worker", "same-origin-frame", "cross-origin-frame",
];
const REQUESTS: readonly ProbeContext[] = [
  "http-window", "http-dedicated-worker", "http-shared-worker", "http-service-worker",
  "http-same-origin-frame", "http-cross-origin-frame",
];
function supported<I extends string>(
  id: I, name: string, configFields: readonly (keyof BrowserFingerprintConfig)[],
  contexts: readonly ProbeContext[], contract: string, evidenceKind: ProbeSpec["evidenceKind"] = "capture",
): ProbeSpec & { readonly id: I } {
  return { id, name, configFields, contexts, contract, evidenceKind, required: true, support: { status: "SUPPORTED" } };
}
function unsupported<I extends string>(id: I, name: string, reason: string): ProbeSpec & { readonly id: I } {
  return { id, name, configFields: [], contexts: ["launch"], contract: reason, evidenceKind: "capture", required: false, support: { status: "UNSUPPORTED", reason } };
}

const COMMON_PROBES = [
  supported("config.provenance", "Persisted configuration and launch payload", ["schemaVersion", "seed", "hardwareProfile"], ["config", "launch"],
    "Direct stored content, reload, ID/list retrieval and actual payload agree, including hardwareProfile id/source/fontProfile/audioProfile. Schema and seed are parameters, not physical hardware facts. Native/off ignores inactive identity values rather than rewriting stored profiles."),
  supported("runtime.version", "Executable and runtime version provenance", ["userAgent"], ["launch", "runtime"],
    "Runner verifies owned PID, executable, profile and binary hash; strictly parsed executable/runtime, Browser.getVersion product and version-page version tuples agree. A UA string or substring in page text is not independent software provenance. Managed full versions and native reduced-UA major follow their separate contracts."),
  supported("identity.full-validator", "Full identity validator assertion receipt", ["userAgent", "appVersion", "vendor", "platform", "platformVersion", "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "languages"], ["config", "launch", "runtime", ...NAVIGATORS, ...REQUESTS],
    "Link the actual full-identity validator's named required assertion receipt, not a generic capture/datatype check or the legacy partial gate. Required value assertions must pass; predeclared native-matched complete Worker hint omission is only a request-shape assertion. Keep absent-value observations visible in the receipt without inventing phantom value passes. Runner verifies validator invocation, receipt bytes/hash and independent runtime/native-control provenance.", "full-identity-assertions"),
  supported("identity.navigator", "Navigator identity across contexts", ["userAgent", "appVersion", "vendor", "platform"], NAVIGATORS,
    "Present, well-formed UA/appVersion/vendor/platform obey the configured managed persona or native/off contract in every listed navigator. Internal agreement alone does not prove configuration fulfillment or physical CPU/OS identity."),
  supported("identity.ua-ch", "UA-CH values and version coherence", ["userAgent", "platform", "platformVersion"], NAVIGATORS,
    "Validate brands/fullVersionList, major/full runtime versions, platform/platformVersion, architecture/bitness, model, mobile, wow64, uaFullVersion and formFactors; preserve missing versus present-empty/false. Managed synthetic x86/64/desktop values are not claims of physical hardware. Native UA reduction is allowed by its explicit version contract."),
  supported("identity.http", "Actual request identity and negotiated hints", ["userAgent", "languages", "doNotTrack", "platformVersion"], REQUESTS,
    "Successful real requests carry the correct UA/Accept-Language/DNT and engine-appropriate hints after recorded opt-in, secure-context and frame delegation. Parse Structured Fields, reject duplicate/conflicting versions. Complete native Worker omission needs a same-host/binary/mode/negotiation control and a separate omission assertion; it verifies no nonexistent hint value. Firefox follows its own native HTTP contract, not Chromium UA-CH."),
  supported("cpu.navigator", "CPU, memory and touch reporting", ["hardwareConcurrency", "deviceMemory", "maxTouchPoints", "hardwareProfile"], NAVIGATORS,
    "Validate actual configured navigator fields and cross-context consistency, including engine-specific exposure/absence and UA-CH coherence. A managed hardware persona is not physical hardware measurement; MacIntel or x86 plus an Apple GPU alone is not an impossible-hardware verdict."),
  supported("gpu.webgl", "WebGL 1/2 identity and full capabilities", ["webgl"], ["window", "dedicated-worker", "native-control"],
    "Capture nonempty complete WebGL1/2 corpora. Chromium identity and all capabilities retain the same-host, same-executable, same-execution-mode native control with empty override sentinels. Firefox retains its independently declared legacy tuple/capability policy; never apply Chromium GPU identity rules to it."),
  supported("gpu.webgpu", "WebGPU adapter and full capabilities", ["webgpu"], ["window", "dedicated-worker", "native-control"],
    "Verify adapter info, features, limits, fallback and subgroup sizes, not just a display string. Chromium mode/native, empty vendor/architecture/device/description and zero subgroup sentinels preserve the complete same-mode native corpus. Firefox uses its own declared tuple policy. Missing adapters are not mutually-equal evidence of capability."),
  supported("screen.geometry", "Screen, window and DPR geometry", ["screen"], ["window", "dedicated-worker", "native-control"],
    "Validate width/height, availLeft/Top/Width/Height, colorDepth/pixelDepth, DPR, windowX/Y, outerWidth/Height, mobile and real inner/outer/coordinate relationships. Record Worker-visible portions or specified absence. Use the actual headed/headless native geometry contract without injecting DPR."),
  supported("screen.css-theme", "CSS resolution, viewport and platform theme", ["screen", "platform", "seed"], ["window", "same-origin-frame", "cross-origin-frame"],
    "Check CSS media queries/resolution, visualViewport and actual platform system-color/selection paint and preferred scheme against the mode-aware contract; do not infer rendered geometry from config alone."),
  supported("locale.language", "Languages and Accept-Language", ["languages"], [...NAVIGATORS, ...REQUESTS],
    "Validate nonempty ordered navigator languages and actual Accept-Language with q values across contexts against configuration, not unconditionally against host locale."),
  supported("locale.timezone", "Timezone, Intl, dates and DST", ["timezone"], NAVIGATORS,
    "Check Intl and Date at predeclared fixed instants including DST boundaries in every listed context. Configured timezone follows configuration; null/native fallback requires its explicit native contract, not equality of two missing values."),
  supported("fonts.corpus", "Font inventory and actual measurement", ["fonts", "hardwareProfile"], ["window", "dedicated-worker"],
    "Use the font corpus, actual measurements and permitted owned-origin Local Font Access to validate the configured font profile. Missing measurements or missing required permission are not a pass; never silently substitute a host font list."),
  supported("canvas.rendering", "Canvas and OffscreenCanvas readback", ["canvas"], ["window", "dedicated-worker"],
    "Check enabled/seed behavior using actual nonempty rendering/readback and OffscreenCanvas, with deterministic assertions rather than equality of absent hashes. Managed noise privacy remains separate from native/off behavior."),
  supported("audio.rendering", "Completed offline audio rendering", ["audio", "hardwareProfile"], ["window"],
    "Validate enabled/seed/amplitude and the audio profile using completed nonempty OfflineAudioContext output. Capture timeout is FAIL, never a successful capability report; no real microphone is needed for this rendering probe."),
  supported("media.devices", "Reported media device contract", ["mediaDevices"], ["window"],
    "Check enabled/audioInputs/videoInputs/audioOutputs, stable per-profile IDs and labels/constraint mapping. An enumerateDevices report is not proof that a camera or microphone can be used."),
  supported("media.capture", "Controlled media capture capability", ["mediaDevices"], ["window"],
    "Actual capture/track settings must match the reported owned fixture/device contract. No permission or controlled device yields evidenced BLOCKED, not fake-device proof of real hardware. Never access real microphones/cameras without separate authorization; timeout is FAIL."),
  supported("media.codecs", "Codec reporting and working capability", [], ["window", "dedicated-worker"],
    "Verify declared AAC/H.264 canPlayType, MediaSource, MediaCapabilities and WebCodecs support and bounded actual encode/decode behavior where exposed. Record engine/context exposure explicitly; reported booleans alone do not prove operation."),
  supported("plugins.mime", "Plugins, MIME and PDF relationships", ["pluginProfile"], ["window", "same-origin-frame", "cross-origin-frame"],
    "Validate pdfViewerEnabled, plugin names/filenames/descriptions, nested MIME types/suffixes, top-level MIME roster and enabledPlugin relationships against the platform-shaped profile; missing arrays are not an empty supported roster."),
  supported("speech.voices", "Speech voice report", ["speechSynthesis"], ["window"],
    "Validate enabled and complete voice names/lang/localService roster, including bounded asynchronous voice readiness. A partial substring match is insufficient."),
  supported("speech.capability", "Controlled speech capability", ["speechSynthesis"], ["window"],
    "Distinguish the reported voice roster from usable synthesis with the declared controlled capability fixture. Missing authorized output prerequisites are evidenced BLOCKED, not a claimed physical voice/device capability."),
  supported("webauthn.report", "WebAuthn capability report", ["webauthn"], ["window"],
    "Validate enabled, conditionalGet/Create, hybridTransport, passkeyPlatformAuthenticator and userVerifyingPlatformAuthenticator with actual API results and secure-context prerequisites; preserve false versus missing."),
  supported("webauthn.capability", "Controlled WebAuthn operation", ["webauthn"], ["window"],
    "Verify the separately declared bounded owned authenticator operation, not just capability booleans. No permission/controlled authenticator is evidenced BLOCKED. Do not read real credentials or infer physical authenticator availability from persona fields."),
  supported("storage.quota", "Modern and legacy quota contracts", ["storageQuotaBytes"], ["window", "dedicated-worker"],
    "Validate actual modern/legacy quota, persistent/temporary and Storage Buckets behavior against configuration. A requested quota is not proof of allocated disk bytes; keep writes bounded."),
  supported("storage.opfs", "Bounded OPFS write, readback and lookup", ["storageQuotaBytes"], ["window", "dedicated-worker"],
    "Write unique owned bytes, directly inspect stored bytes, reopen/read back and look up the named entry; compare actual bytes rather than only file size. Clean only the object created by this probe, never other profile storage."),
  supported("geolocation.behavior", "Geolocation mode and coordinates", ["geolocation"], ["window"],
    "Verify configured real/disable/custom mode, latitude/longitude/accuracy and actual permission/error or owned-fixture behavior. No authorization for physical location is evidenced BLOCKED; a reported coordinate object alone is not working geolocation."),
  supported("privacy.do-not-track", "DNT property and wire behavior", ["doNotTrack"], ["window", ...REQUESTS],
    "Validate navigator.doNotTrack and actual request DNT against the configured or native/off contract, preserving null/absence distinctions."),
  supported("network.webrtc", "Configured WebRTC candidate and communication behavior", ["webrtc"], ["window", "proxy"],
    "Validate the configured real/altered/disable mode and publicIp using actual bounded ICE/candidate/communication and route evidence. Empty iceServers alone cannot prove privacy for all modes; other configuration variants need separately bound receipts, not fabricated UNSUPPORTED rows."),
  supported("network.proxy-dns", "Proxy DNS routing and fail-closed behavior", ["secureDns"], ["dns", "proxy"],
    "Correlate real hostname requests, DNS-only queries/responses and selected HTTP/SOCKS hostname forwarding. Proxy failures must not leak direct DNS/traffic or fall back, including native/off identity. A configured log line or successful navigation alone is not DNS transaction evidence."),
  supported("network.strict-doh", "Declared secure DNS policy and transactions", ["secureDns"], ["config", "dns", "proxy"],
    "Validate enabled/templates and actual selected policy. Enabled strict DoH requires successful normally trusted TLS transactions plus failure/no-fallback evidence through the owned proxy; disabled policy cannot be reported as a successful DoH transaction. Preserve NOTFOUND privacy policy and never alter system DNS/VPN/TLS to obtain a pass."),
  supported("network.dns-site", "Reported DNS-site mechanism and retest", ["secureDns"], ["dns"],
    "The reported detector requires authorized access, its actual DNS-only/request mechanism and correlated resolver evidence. Unavailable lawful access is evidenced BLOCKED. Do not fabricate resolver_count, bypass access restrictions or promise a third-party score."),
  supported("lifecycle.seed-profile", "Explicit restart, seed stability and profile isolation", ["seed", "hardwareProfile", "canvas", "audio", "fonts"], ["launch", "restart-same-seed", "restart-new-seed", "second-profile"],
    "Prove owned browser stop then relaunch: managed same-seed expected fields stay stable and predeclared seed-sensitive fields change on fixed new seed. Validate a second owned profile's declared stability/isolation. Native GPU and native/off identity must not be forced to change; comparison captures need runner-verified source/binary/config/profile provenance."),
  supported("lifecycle.reuse-guards", "Startup identity and verified reuse", ["platform", "seed", "secureDns"], ["config", "launch"],
    "Persist/reload/launch readback and verified PID/profile evidence distinguish a fresh identity from an old browser. Changed or unverifiable identity/mode/DNS yields explicit restart-required without automatic killing; portable foreign profile metadata is preserved."),
] as const;

const CHROMIUM_PROBES = [
  unsupported("support.foreign-platform", "Foreign-OS managed Chromium launch", "Managed Chromium does not support a persona OS different from its macOS/Windows host. Portable storage is supported, local launch is rejected."),
  unsupported("support.android", "Android managed Chromium launch", "The desktop native Chromium reader does not support Android launch identities. Stored Android profiles must not be silently rewritten or counted as a supported desktop permutation."),
  unsupported("support.gpu-override", "Explicit Chromium GPU overrides", "Chromium preserves native GPU identity/capabilities and rejects explicit GPU override values; Firefox's tuple policy is independent."),
  unsupported("support.native-strict-doh", "Native/off plus explicit strict DoH", "This Chromium engine requires managed identity for explicit strict proxy DoH; native/off retains default proxy DNS privacy but this launch combination is rejected."),
  supported("launch.reject-foreign-platform", "Reject foreign-OS Chromium launch", ["platform"], ["config", "launch"],
    "An owned incompatible foreign-OS profile remains retrievable unchanged and actual production launch is refused before executing a browser. A mock rejection is not production evidence."),
  supported("launch.reject-android", "Reject Android Chromium launch", ["platform"], ["config", "launch"],
    "An owned Android profile remains portable/retrievable and actual production desktop Chromium launch is refused before executing a browser."),
  supported("launch.reject-gpu-override", "Reject explicit Chromium GPU override", ["webgl", "webgpu"], ["config", "launch"],
    "Actual production launch rejects nonempty legacy GPU override metadata instead of silently ignoring it, without rewriting the profile or applying this Chromium rejection to Firefox."),
  supported("launch.reject-native-strict-doh", "Reject native/off strict DoH", ["secureDns"], ["config", "launch"],
    "Actual production launch rejects native/off plus explicit strict DoH while preserving inactive stored identity and default proxy DNS privacy."),
] as const;

export type FingerprintProbeId = typeof COMMON_PROBES[number]["id"] | typeof CHROMIUM_PROBES[number]["id"];
interface FieldCoverage {
  readonly kind: "surface" | "parameter" | "provenance";
  readonly reason: string;
  readonly probes: readonly FingerprintProbeId[];
}
/** Compile-time exhaustive: a newly declared config field cannot disappear. */
export const FINGERPRINT_FIELD_INVENTORY = Object.freeze({
  schemaVersion: { kind: "parameter", reason: "Native reader schema selector, verified in persisted/payload provenance rather than as a navigator property.", probes: ["config.provenance"] },
  seed: { kind: "parameter", reason: "Privacy derivation input; verify payload and specified restart/seed behavior, not physical hardware identity.", probes: ["config.provenance", "lifecycle.seed-profile", "lifecycle.reuse-guards"] },
  platform: { kind: "surface", reason: "Managed host-compatible persona or native identity.", probes: ["identity.navigator", "identity.ua-ch", "lifecycle.reuse-guards"] },
  platformVersion: { kind: "surface", reason: "Managed/native UA-CH platform-version contract, not a physical OS assertion.", probes: ["identity.ua-ch", "identity.http"] },
  userAgent: { kind: "surface", reason: "Navigator, wire and independent runtime version checks.", probes: ["identity.navigator", "identity.http", "runtime.version"] },
  appVersion: { kind: "surface", reason: "Navigator appVersion across supported contexts.", probes: ["identity.navigator"] },
  vendor: { kind: "surface", reason: "Engine-specific navigator vendor.", probes: ["identity.navigator"] },
  languages: { kind: "surface", reason: "Configured navigator languages and real request negotiation.", probes: ["locale.language", "identity.http"] },
  hardwareConcurrency: { kind: "surface", reason: "Managed CPU report versus native/off exposure, not physical CPU rewriting.", probes: ["cpu.navigator"] },
  deviceMemory: { kind: "surface", reason: "Engine-aware memory report/exposure.", probes: ["cpu.navigator"] },
  maxTouchPoints: { kind: "surface", reason: "Configured touch report and cross-context contract.", probes: ["cpu.navigator"] },
  hardwareProfile: { kind: "provenance", reason: "Catalog id/source/fontProfile/audioProfile metadata are not physical hardware measurements.", probes: ["config.provenance", "cpu.navigator", "fonts.corpus", "audio.rendering"] },
  screen: { kind: "surface", reason: "All declared screen, available area, window position/size, depth, mobile and DPR members.", probes: ["screen.geometry", "screen.css-theme"] },
  storageQuotaBytes: { kind: "surface", reason: "Reported quota and bounded real storage operations are separate.", probes: ["storage.quota", "storage.opfs"] },
  canvas: { kind: "surface", reason: "Enabled/seed and actual canvas/OffscreenCanvas readback.", probes: ["canvas.rendering", "lifecycle.seed-profile"] },
  audio: { kind: "surface", reason: "Enabled/seed/amplitude and completed offline rendering.", probes: ["audio.rendering", "lifecycle.seed-profile"] },
  webgl: { kind: "surface", reason: "Vendor/renderer plus full capabilities; native Chromium versus independent Firefox policy.", probes: ["gpu.webgl"] },
  webgpu: { kind: "surface", reason: "Mode, vendor/architecture/device/description, subgroup sizes and full native capabilities.", probes: ["gpu.webgpu"] },
  webauthn: { kind: "surface", reason: "All declared enabled/conditional/hybrid/platform-authenticator members; report and operation differ.", probes: ["webauthn.report", "webauthn.capability"] },
  speechSynthesis: { kind: "surface", reason: "Enabled and voice name/lang/localService roster versus usable synthesis.", probes: ["speech.voices", "speech.capability"] },
  webrtc: { kind: "surface", reason: "Configured real/altered/disable mode and publicIp need actual route/candidate behavior.", probes: ["network.webrtc"] },
  timezone: { kind: "surface", reason: "Configured or native-fallback timezone with fixed-instant Intl/Date/DST behavior.", probes: ["locale.timezone"] },
  geolocation: { kind: "surface", reason: "Mode and nullable latitude/longitude/accuracy with explicit permission prerequisites.", probes: ["geolocation.behavior"] },
  mediaDevices: { kind: "surface", reason: "Enabled and audioInputs/videoInputs/audioOutputs report versus actual controlled capability.", probes: ["media.devices", "media.capture"] },
  secureDns: { kind: "surface", reason: "Enabled/templates, actual DNS transactions, fail-closed routing and reported site retest.", probes: ["network.proxy-dns", "network.strict-doh", "network.dns-site"] },
  fonts: { kind: "surface", reason: "Configured allowlist and actual font corpus measurement.", probes: ["fonts.corpus", "lifecycle.seed-profile"] },
  doNotTrack: { kind: "surface", reason: "Nullable property and actual wire DNT.", probes: ["privacy.do-not-track", "identity.http"] },
  pluginProfile: { kind: "surface", reason: "PDF flag, complete plugin and nested/top-level MIME rosters and links.", probes: ["plugins.mime"] },
} as const satisfies Record<keyof BrowserFingerprintConfig, FieldCoverage>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function laneProblem(value: unknown): string | undefined {
  if (!isRecord(value) || (value.hostPlatform !== "darwin" && value.hostPlatform !== "win32") ||
      (value.engine !== "chromium" && value.engine !== "firefox") ||
      (value.mode !== "headed" && value.mode !== "headless") ||
      (value.identityMode !== "managed" && value.identityMode !== "native")) return "Invalid acceptance lane";
  return undefined;
}
function freezeSpec(spec: ProbeSpec): ProbeSpec {
  return Object.freeze({ ...spec, configFields: Object.freeze([...spec.configFields]), contexts: Object.freeze([...spec.contexts]), support: Object.freeze({ ...spec.support }) });
}

/** Only predeclared supported lanes; absence of a runner never changes support. */
export function createFingerprintProbeManifest(lane: ProbeLane): ProbeManifest {
  const problem = laneProblem(lane);
  if (problem) throw new Error(problem);
  const probes: ProbeSpec[] = COMMON_PROBES.map((spec) => {
    if (lane.engine === "firefox" && spec.id === "identity.ua-ch") {
      return { ...spec, required: false, support: { status: "UNSUPPORTED", reason: "Firefox does not declare Chromium UA-CH; its navigator/runtime/HTTP identity contracts remain required and independent." } };
    }
    return spec;
  });
  if (lane.engine === "chromium") probes.push(...CHROMIUM_PROBES);
  return Object.freeze({
    schemaVersion: FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION,
    manifestVersion: FINGERPRINT_PROBE_MANIFEST_VERSION,
    lane: Object.freeze({ hostPlatform: lane.hostPlatform, engine: lane.engine, mode: lane.mode, identityMode: lane.identityMode }),
    probes: Object.freeze(probes.map(freezeSpec)),
  });
}

function sameList(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}
function canonicalManifest(manifest: ProbeManifest): ProbeManifest {
  if (!isRecord(manifest) || manifest.schemaVersion !== FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION ||
      manifest.manifestVersion !== FINGERPRINT_PROBE_MANIFEST_VERSION || !Array.isArray(manifest.probes)) {
    throw new Error("Invalid acceptance manifest schema/version/probes");
  }
  const canonical = createFingerprintProbeManifest(manifest.lane);
  if (manifest.probes.length !== canonical.probes.length) throw new Error("Invalid acceptance manifest: fixed probe inventory changed");
  canonical.probes.forEach((expected, index) => {
    const actual = manifest.probes[index];
    if (!isRecord(actual) || actual.id !== expected.id || actual.name !== expected.name || actual.contract !== expected.contract ||
        actual.required !== expected.required || actual.evidenceKind !== expected.evidenceKind || !sameList(actual.contexts, expected.contexts) ||
        !sameList(actual.configFields, expected.configFields) || !isRecord(actual.support) ||
        actual.support.status !== expected.support.status ||
        (expected.support.status === "UNSUPPORTED" &&
          (actual.support.status !== "UNSUPPORTED" || actual.support.reason !== expected.support.reason))) {
      throw new Error(`Invalid acceptance manifest: declaration changed at ${expected.id}`);
    }
  });
  return canonical;
}

const BINDING_KEYS = [
  "schemaVersion", "manifestVersion", "sourceRevision", "sourceDirty", "sourceSha256", "binarySha256", "configSha256",
  "runId", "hostId", "profileId", "hostPlatform", "engine", "mode", "identityMode",
] as const satisfies readonly (keyof EvidenceBinding)[];
const SHA256 = /^[0-9a-f]{64}$/;
function bindingProblem(value: unknown, manifest: ProbeManifest): string | undefined {
  if (!isRecord(value) || laneProblem(value)) return "Invalid evidence binding/lane";
  if (value.schemaVersion !== manifest.schemaVersion || value.manifestVersion !== manifest.manifestVersion) return "Evidence schema/manifest version mismatch";
  for (const key of ["sourceRevision", "runId", "hostId", "profileId"] as const) {
    if (!hasText(value[key])) return `Missing evidence binding ${key}`;
  }
  if (typeof value.sourceDirty !== "boolean") return "Missing evidence binding sourceDirty";
  for (const key of ["sourceSha256", "binarySha256", "configSha256"] as const) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) return `Invalid evidence binding ${key}`;
  }
  for (const key of ["hostPlatform", "engine", "mode", "identityMode"] as const) {
    if (value[key] !== manifest.lane[key]) return `Evidence lane mismatch: ${key}`;
  }
  return undefined;
}
function snapshotBinding(binding: EvidenceBinding): EvidenceBinding {
  return Object.freeze(Object.fromEntries(BINDING_KEYS.map((key) => [key, binding[key]]))) as unknown as EvidenceBinding;
}
function isProbeValue(value: unknown, ancestors = new Set<object>(), depth = 0): value is ProbeValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => isProbeValue(item, ancestors, depth + 1))
    : isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((item) => isProbeValue(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}
function snapshotValue(value: ProbeValue): ProbeValue {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotValue));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotValue(item as ProbeValue)])));
  return value;
}
function evidenceProblem(value: unknown, spec: ProbeSpec, binding: EvidenceBinding, manifest: ProbeManifest): string | undefined {
  if (!Array.isArray(value)) return "Evidence must be an array";
  const ids = new Set<string>();
  for (const ref of value) {
    if (!isRecord(ref) || !hasText(ref.id) || ids.has(ref.id)) return "Missing/duplicate evidence reference ID";
    ids.add(ref.id);
    if (ref.probeId !== spec.id) return "Evidence probe ID mismatch";
    if ((ref.context === "prerequisite" && ref.kind !== "prerequisite") ||
        (ref.context !== "prerequisite" && ref.kind !== "capture" && ref.kind !== "full-identity-assertions")) return "Evidence kind mismatch";
    if (ref.context !== "prerequisite" && !spec.contexts.includes(ref.context as ProbeContext)) return "Evidence context mismatch";
    if (!hasText(ref.artifact) || !hasText(ref.locator) || typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256)) return "Missing/malformed concrete artifact reference";
    const problem = bindingProblem(ref.binding, manifest);
    if (problem) return problem;
    const candidate = ref.binding as unknown as EvidenceBinding;
    const mismatch = BINDING_KEYS.find((key) => candidate[key] !== binding[key]);
    if (mismatch) return `Evidence binding mismatch: ${mismatch}`;
  }
  return undefined;
}
function referenceIdsProblem(value: unknown, evidence: readonly EvidenceReference[], context: EvidenceReference["context"], kind: EvidenceReference["kind"]): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return "Missing check/prerequisite evidence IDs";
  const ids = new Set<string>();
  for (const id of value) {
    if (!hasText(id) || ids.has(id)) return "Missing/duplicate check evidence ID";
    ids.add(id);
    const ref = evidence.find((item) => item.id === id);
    if (!ref || ref.context !== context || ref.kind !== kind) return "Check/prerequisite evidence context, kind or ID mismatch";
  }
  return undefined;
}
function checksProblem(value: unknown, spec: ProbeSpec, evidence: readonly EvidenceReference[]): string | undefined {
  if (!Array.isArray(value)) return "Checks must be an array";
  const ids = new Set<string>();
  for (const check of value) {
    if (!isRecord(check) || !hasText(check.id) || ids.has(check.id)) return "Missing/duplicate named check ID";
    ids.add(check.id);
    if (!spec.contexts.includes(check.context as ProbeContext) || typeof check.passed !== "boolean") return "Invalid check context/outcome";
    if (!Object.hasOwn(check, "expected") || !Object.hasOwn(check, "actual") || !isProbeValue(check.expected) || !isProbeValue(check.actual)) return "Missing/malformed expected or actual observation";
    if (check.reason !== undefined && (!hasText(check.reason) || check.passed)) return "Successful check has a failure reason, or failure reason is malformed";
    const problem = referenceIdsProblem(check.evidenceIds, evidence, check.context as ProbeContext, spec.evidenceKind);
    if (problem) return problem;
  }
  return undefined;
}
function snapshotEvidence(evidence: readonly EvidenceReference[]): readonly EvidenceReference[] {
  return Object.freeze(evidence.map((ref) => Object.freeze({ ...ref, binding: snapshotBinding(ref.binding) })));
}
function snapshotChecks(checks: readonly ProbeCheck[]): readonly ProbeCheck[] {
  return Object.freeze(checks.map((check) => Object.freeze({ ...check, expected: snapshotValue(check.expected), actual: snapshotValue(check.actual), evidenceIds: Object.freeze([...check.evidenceIds]) })));
}
function normalizeResult(spec: ProbeSpec, result: ProbeResult | undefined, binding: EvidenceBinding, manifest: ProbeManifest): AcceptanceProbeResult {
  const outcome = (status: ProbeStatus, reason?: string, checks: readonly ProbeCheck[] = [], evidence: readonly EvidenceReference[] = []): AcceptanceProbeResult => Object.freeze({
    id: spec.id, name: spec.name, required: spec.required, support: spec.support, status,
    ...(reason === undefined ? {} : { reason }), checks: snapshotChecks(checks), evidence: snapshotEvidence(evidence),
    ...(result?.timedOut === true ? { timedOut: true } : {}),
    ...(status === "BLOCKED" && result?.blocker ? { blocker: Object.freeze({ prerequisite: result.blocker.prerequisite, evidenceIds: Object.freeze([...result.blocker.evidenceIds]) }) } : {}),
  });
  if (!result) return spec.support.status === "UNSUPPORTED"
    ? outcome("UNSUPPORTED", spec.support.reason) : outcome("NOTRUN", "No result submitted");
  if (result.timedOut === true) return outcome("FAIL", "Probe timed out");
  if (result.timedOut !== undefined && typeof result.timedOut !== "boolean") return outcome("FAIL", "Malformed timeout flag");
  if (!["PASS", "FAIL", "BLOCKED", "NOTRUN", "UNSUPPORTED"].includes(result.status)) return outcome("FAIL", "Invalid probe status");
  if (result.reason !== undefined && !hasText(result.reason)) return outcome("FAIL", "Malformed result reason");
  const evidence = result.evidence === undefined ? [] : result.evidence;
  const checks = result.checks === undefined ? [] : result.checks;
  const malformed = evidenceProblem(evidence, spec, binding, manifest) ?? checksProblem(checks, spec, evidence);
  if (malformed) return outcome("FAIL", malformed);
  const failedCheck = checks.find((check) => !check.passed);
  if (failedCheck) return outcome("FAIL", failedCheck.reason ?? `Check failed: ${failedCheck.id}`, checks, evidence);
  if (spec.support.status === "UNSUPPORTED") {
    if (result.status !== "UNSUPPORTED" || checks.length > 0 || evidence.length > 0 || result.blocker !== undefined ||
        (result.reason !== undefined && result.reason !== spec.support.reason)) return outcome("FAIL", "Result contradicts predeclared unsupported contract", checks, evidence);
    return outcome("UNSUPPORTED", spec.support.reason);
  }
  if (result.status === "UNSUPPORTED") return outcome("FAIL", "Supported probe cannot be rewritten to UNSUPPORTED", checks, evidence);
  if (result.status === "PASS") {
    if (result.reason !== undefined || result.blocker !== undefined) return outcome("FAIL", "PASS cannot carry a failure/prerequisite reason", checks, evidence);
    const missing = spec.contexts.filter((context) => !checks.some((check) => check.context === context));
    if (checks.length === 0 || missing.length > 0) return outcome("FAIL", `PASS lacks evidenced checks for required contexts: ${missing.join(", ")}`, checks, evidence);
    return outcome("PASS", undefined, checks, evidence);
  }
  if (result.status === "BLOCKED") {
    const blocker = result.blocker;
    if (!hasText(result.reason) || !isRecord(blocker) || !hasText(blocker.prerequisite)) return outcome("FAIL", "BLOCKED requires a prerequisite reason and evidence", checks, evidence);
    const problem = referenceIdsProblem(blocker.evidenceIds, evidence, "prerequisite", "prerequisite");
    if (problem) return outcome("FAIL", problem, checks, evidence);
    return outcome("BLOCKED", result.reason, checks, evidence);
  }
  if (result.blocker !== undefined) return outcome("FAIL", "Prerequisite blocker requires BLOCKED status", checks, evidence);
  if (result.status === "NOTRUN") return checks.length > 0
    ? outcome("FAIL", "NOTRUN cannot contain completed checks", checks, evidence)
    : outcome("NOTRUN", result.reason ?? "Probe not executed", checks, evidence);
  return outcome("FAIL", result.reason ?? "Probe reported FAIL without a failure reason", checks, evidence);
}

/**
 * Unknown/duplicate IDs and altered manifests/bindings are rejected. Malformed
 * known results, timeouts and contradictory statuses remain named FAIL rows;
 * omitted supported rows remain NOTRUN. No receipt can shrink the fixed set.
 * Evidence shape/binding is not evidence authenticity or executable verification.
 */
export function aggregateFingerprintAcceptance(
  manifest: ProbeManifest, binding: EvidenceBinding, results: readonly ProbeResult[],
): AcceptanceSummary {
  const canonical = canonicalManifest(manifest);
  const problem = bindingProblem(binding, canonical);
  if (problem) throw new Error(problem);
  if (!Array.isArray(results)) throw new Error("Probe results must be an array");
  const known = new Set(canonical.probes.map((spec) => spec.id));
  const byId = new Map<string, ProbeResult>();
  for (const result of results as readonly ProbeResult[]) {
    if (!isRecord(result) || !hasText(result.id) || !known.has(result.id)) throw new Error("Unknown/malformed probe result ID");
    if (byId.has(result.id)) throw new Error(`Duplicate probe result ID: ${result.id}`);
    byId.set(result.id, result);
  }
  const subject = snapshotBinding(binding);
  const rows = Object.freeze(canonical.probes.map((spec) => normalizeResult(spec, byId.get(spec.id), subject, canonical)));
  const totals = { total: rows.length, supported: 0, required: 0, requiredPassed: 0, PASS: 0, FAIL: 0, BLOCKED: 0, NOTRUN: 0, UNSUPPORTED: 0 };
  for (const row of rows) {
    totals[row.status] += 1;
    if (row.support.status === "SUPPORTED") totals.supported += 1;
    if (row.required && row.support.status === "SUPPORTED") {
      totals.required += 1;
      if (row.status === "PASS") totals.requiredPassed += 1;
    }
  }
  const eligible = totals.required > 0 && totals.requiredPassed === totals.required &&
    totals.FAIL === 0 && totals.BLOCKED === 0 && totals.NOTRUN === 0;
  return Object.freeze({ schemaVersion: FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION, manifestVersion: canonical.manifestVersion, binding: subject, results: rows, totals: Object.freeze(totals), eligible });
}
