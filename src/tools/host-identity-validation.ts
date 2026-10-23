import {
  verifyHostIdentityCoherence,
  type HostIdentityCorpus, type HostIdentityRequestHeaders, type HostNavigatorIdentity,
} from "./host-identity-corpus.js";
import {
  ClientHintsParseError, isChromiumGreaseBrand, parseChromeVersionElement, parseChromiumFullVersion,
  parseChromiumProductVersion, parseChromiumUserAgentVersion, parseClientHintBoolean,
  parseClientHintBrands, parseClientHintFormFactors, parseClientHintString,
  type ClientHintBrand,
} from "./client-hints.js";

export const IDENTITY_CONTEXTS = ["window", "dedicated", "shared", "service", "same-origin-frame", "cross-origin-frame"] as const;
export type IdentityContext = typeof IDENTITY_CONTEXTS[number];
export type IdentityStatus = "PASS" | "FAIL" | "BLOCKED" | "NOTRUN" | "UNSUPPORTED";
export type IdentityMode = "managed" | "off";
export type IdentityCaptureStatus = "captured" | "timeout" | "error" | "notrun" | "blocked";
export type HostIdentityBrand = ClientHintBrand;
export interface HostIdentityHighEntropy extends Record<string, unknown> {
  architecture?: string; bitness?: string; platform?: string; platformVersion?: string;
  fullVersionList?: HostIdentityBrand[]; uaFullVersion?: string; model?: string;
  wow64?: boolean; mobile?: boolean; formFactors?: string[]; brands?: HostIdentityBrand[];
}
export interface FullHostNavigatorIdentity extends HostNavigatorIdentity {
  brands?: HostIdentityBrand[] | null;
  highEntropy: HostIdentityHighEntropy | null;
}
export interface FullHostIdentityRequestHeaders extends HostIdentityRequestHeaders {
  uaBrands?: string | null; uaMobile?: string | null; uaFullVersionList?: string | null;
  uaFullVersion?: string | null; uaModel?: string | null; uaWow64?: string | null; uaFormFactors?: string | null;
}
export interface IdentityRunBinding {
  runId: string; hostId: string; profileId: string; pid: number; executablePath: string; executableSha256: string;
  mode: "headed" | "headless"; identityMode: IdentityMode;
}
export interface IdentityRuntimeReceipt {
  product: string; versionElement: string; executableFullVersion: string; userAgent: string;
  versionElementSource: "chrome://version#version";
  binding: IdentityRunBinding;
  /** Independently read back from the owned launcher/process, not copied from configured identity. */
  verifiedBinding: IdentityRunBinding;
}
export interface IdentityNegotiation {
  origin: string; topLevelOrigin: string; secureContext: boolean; optInResponseReceived: boolean;
  postOptInRequest: boolean; permissionsPolicyDelegated: boolean;
  /** HTTP hint names, case-insensitive; delegatedHints uses the same names, not policy feature names. */
  acceptCH: readonly string[]; delegatedHints: readonly string[];
}
export interface IdentityNavigatorCapture {
  status: IdentityCaptureStatus; identity?: FullHostNavigatorIdentity; reason?: string;
}
export interface IdentityRequestEvidence {
  status: IdentityCaptureStatus; responseStatus?: number; requestUrl?: string; reason?: string;
  negotiation?: IdentityNegotiation;
}
/** New evidence is optional structurally so existing partial corpus callers remain source-compatible. */
export interface FullHostIdentityCorpus extends HostIdentityCorpus {
  window: FullHostNavigatorIdentity; worker: FullHostNavigatorIdentity;
  requestHeaders: Record<"window" | "dedicated" | "shared" | "service", FullHostIdentityRequestHeaders> &
    Partial<Record<"same-origin-frame" | "cross-origin-frame", FullHostIdentityRequestHeaders>>;
  binding?: IdentityRunBinding;
  navigators?: Partial<Record<IdentityContext, IdentityNavigatorCapture>>;
  requestEvidence?: Partial<Record<IdentityContext, IdentityRequestEvidence>>;
}
export interface ManagedHostIdentityExpected {
  userAgent: string; platform: string; platformVersion: string; uaPlatform?: string;
  architecture?: string; bitness?: string; model?: string; mobile?: boolean; wow64?: boolean;
  realBrands?: readonly string[]; formFactors?: readonly string[];
}
export interface FullHostIdentityContract {
  mode: IdentityMode; hostPlatform: string; expectedManaged?: ManagedHostIdentityExpected;
  optionalHints?: { uaFullVersion?: boolean; formFactors?: boolean };
  workerHintPolicy?: "required" | "native-control-omission";
  /** Opt-in CPU truthfulness, separate from the legacy configured-persona contract. */
  managedCpuPolicy?: "native-control";
}
export interface NativeHostIdentityControl { actual: FullHostIdentityCorpus; runtime: IdentityRuntimeReceipt }
export interface FullHostIdentityInput extends NativeHostIdentityControl {
  contract: FullHostIdentityContract; nativeControl?: NativeHostIdentityControl;
}
export type IdentityAssertionKind = "runtime" | "coherence" | "managed-config" | "native-hardware" | "capture" | "prerequisite" | "omission";
export interface HostIdentityAssertion {
  id: string; kind: IdentityAssertionKind; status: IdentityStatus; required: boolean;
  expected: unknown; observed: unknown; reasons: string[];
  conditionalNotApplicableReason?: string;
}
export interface FullHostIdentityValidation {
  status: IdentityStatus; assertions: HostIdentityAssertion[]; runtimeVersion?: string;
  nativeControl?: FullHostIdentityValidation;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ?
  Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const workerContext = (context: IdentityContext): boolean => ["dedicated", "shared", "service"].includes(context);
const frameContext = (context: IdentityContext): boolean => context.endsWith("-frame");
const sorted = (values: readonly string[]): string[] => [...values].sort();
const problem = (message: string): never => { throw new ClientHintsParseError(message); };
function brands(value: unknown, full: boolean): HostIdentityBrand[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) return problem("Missing or invalid brand list");
  const seen = new Set<string>();
  const real: HostIdentityBrand[] = [];
  for (const item of value) {
    if (!record(item) || !present(item.brand) || /[^\x20-\x7e]/.test(item.brand) || !present(item.version)) return problem("Invalid brand member");
    if (seen.has(item.brand)) return problem(`Duplicate brand: ${item.brand}`);
    seen.add(item.brand);
    if (full) parseChromiumFullVersion(item.version);
    else if (item.version !== item.version.trim() || !/^[1-9]\d*$/.test(item.version)) return problem("Low-entropy brand version must be a canonical major");
    const member = { brand: item.brand, version: item.version };
    if (!isChromiumGreaseBrand(member)) real.push(member);
  }
  if (!real.some((item) => item.brand === "Chromium")) return problem("Missing required real brand Chromium");
  return real.sort((left, right) => left.brand < right.brand ? -1 : left.brand > right.brand ? 1 : 0);
}
function stringSet(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => !present(item)) || new Set(value).size !== value.length) {
    return problem("Expected a nonempty list of unique strings");
  }
  return sorted(value);
}
function hintNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => !present(item) || item !== item.trim() || !/^[a-z0-9-]+$/i.test(item))) return problem("Invalid negotiation hint names");
  const names = value.map((item: string) => item.toLowerCase());
  if (new Set(names).size !== names.length) return problem("Duplicate negotiation hint names");
  return sorted(names);
}
function canonicalOrigin(value: unknown): string {
  if (!present(value)) return problem("Missing origin");
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) return problem("Expected an exact HTTP(S) origin");
    return url.origin;
  } catch (error) {
    if (error instanceof TypeError) return problem("Invalid origin URL");
    throw error;
  }
}
function bindingValid(value: unknown): value is IdentityRunBinding {
  return record(value) && ["runId", "hostId", "profileId", "executablePath"].every((key) => present(value[key])) &&
    typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.executableSha256 === "string" && value.executableSha256.length === 64 && /^[a-f0-9]{64}$/.test(value.executableSha256) &&
    (value.mode === "headed" || value.mode === "headless") && (value.identityMode === "managed" || value.identityMode === "off");
}
function bindingFields(value: IdentityRunBinding, control = false): unknown {
  const { runId, hostId, executablePath, executableSha256, mode, profileId, pid, identityMode } = value;
  return control ? { runId, hostId, executablePath, executableSha256, mode } :
    { runId, hostId, executablePath, executableSha256, mode, profileId, pid, identityMode };
}
const HINTS = [
  ["uaBrands", "sec-ch-ua", "brands", "brands"], ["uaMobile", "sec-ch-ua-mobile", "mobile", "boolean"],
  ["uaPlatform", "sec-ch-ua-platform", "uaPlatform", "string"], ["uaArchitecture", "sec-ch-ua-arch", "architecture", "string"],
  ["uaBitness", "sec-ch-ua-bitness", "bitness", "string"], ["uaPlatformVersion", "sec-ch-ua-platform-version", "platformVersion", "string"],
  ["uaFullVersionList", "sec-ch-ua-full-version-list", "fullVersionList", "full-brands"], ["uaModel", "sec-ch-ua-model", "model", "string"],
  ["uaWow64", "sec-ch-ua-wow64", "wow64", "boolean"], ["uaFullVersion", "sec-ch-ua-full-version", "uaFullVersion", "string"],
  ["uaFormFactors", "sec-ch-ua-form-factors", "formFactors", "strings"],
] as const;

/** Pure, fixed six-context gate. No browser/process/network/storage operations occur here. */
export function validateFullHostIdentity(input: FullHostIdentityInput): FullHostIdentityValidation {
  if (!record(input) || (input.nativeControl !== undefined && !record(input.nativeControl))) return invalidInput(input);
  const control = input.nativeControl ? validateIdentity({
    ...input.nativeControl, contract: { ...input.contract, mode: "off", expectedManaged: undefined, managedCpuPolicy: undefined },
  }, true) : undefined;
  return validateIdentity(input, false, control);
}
function invalidInput(observed: unknown): FullHostIdentityValidation {
  return { status: "FAIL", assertions: [{ id: "input.shape", kind: "capture", status: "FAIL", required: true,
    expected: "typed actual corpus, runtime receipt and contract", observed, reasons: ["Missing or invalid full identity input shape"] }] };
}
function validateIdentity(input: FullHostIdentityInput, controlRole: boolean, control?: FullHostIdentityValidation): FullHostIdentityValidation {
  const { actual, runtime, contract } = input;
  if (!record(actual) || !record(runtime) || !record(contract)) return invalidInput(input);
  const assertions: HostIdentityAssertion[] = [];
  const add = (id: string, kind: IdentityAssertionKind, ok: boolean, expected: unknown, observed: unknown, reason: string): boolean => {
    assertions.push({ id, kind, status: ok ? "PASS" : "FAIL", required: true, expected, observed, reasons: ok ? [] : [reason] });
    return ok;
  };
  const defer = (id: string, kind: IdentityAssertionKind, status: "NOTRUN" | "BLOCKED", observed: unknown, reason: string, conditional = false): void => {
    assertions.push({ id, kind, status, required: !conditional, expected: "captured and verified", observed, reasons: [reason],
      ...(conditional ? { conditionalNotApplicableReason: reason } : {}) });
  };
  const parse = <T>(id: string, kind: IdentityAssertionKind, observed: unknown, parser: () => T): T | undefined => {
    try {
      const result = parser();
      add(id, kind, true, "well-formed value", observed, "");
      return result;
    } catch (error) {
      if (!(error instanceof ClientHintsParseError)) throw error;
      add(id, kind, false, "well-formed value", observed, error.message);
      return undefined;
    }
  };
  const capture = (id: string, value: { status?: string; reason?: string } | undefined, blocked: boolean): boolean => {
    if (value?.status === "notrun" || (blocked && (!value || value.status === "blocked" || value.status === "captured"))) {
      defer(id, "capture", blocked ? "BLOCKED" : "NOTRUN", value, value?.reason || (blocked ? "Explicit frame prerequisites are unavailable" : "Capture was not run"));
      return false;
    }
    return add(id, "capture", value?.status === "captured", "captured", value, value?.reason || "Capture missing, failed, timed out, or has an invalid status");
  };
  const hostPlatform = contract.hostPlatform === "darwin" ? "MacIntel" : contract.hostPlatform === "win32" ? "Win32" : undefined;
  const uaPlatform = hostPlatform === "MacIntel" ? "macOS" : hostPlatform === "Win32" ? "Windows" : undefined;
  add("contract.supported-host", "prerequisite", Boolean(hostPlatform), "darwin or win32", contract.hostPlatform, "Host is not in the declared supported desktop contract");
  add("contract.mode", "prerequisite", contract.mode === "managed" || contract.mode === "off", "managed or off", contract.mode, "Invalid identity mode");
  const requiresNativeCpu = contract.mode === "managed" && contract.managedCpuPolicy === "native-control";
  add("contract.managed-cpu-policy", "prerequisite", contract.managedCpuPolicy === undefined ||
    requiresNativeCpu && contract.hostPlatform === "darwin", "omitted, or native-control on a managed macOS run", contract.managedCpuPolicy,
  "Unknown CPU policy or unsupported CPU truthfulness scope");
  const bindingOK = add("runtime.binding", "runtime", bindingValid(runtime.binding) && bindingValid(runtime.verifiedBinding) && bindingValid(actual.binding) &&
    same(bindingFields(runtime.binding), bindingFields(runtime.verifiedBinding)) && same(bindingFields(runtime.binding), bindingFields(actual.binding)) &&
    runtime.binding.identityMode === contract.mode, runtime.verifiedBinding, { receipt: runtime.binding, capture: actual.binding }, "Missing, invalid, or mismatched independently verified run/profile/PID/executable/mode binding");
  const product = parse("runtime.product", "runtime", runtime.product, () => parseChromiumProductVersion(runtime.product));
  const element = parse("runtime.version-element", "runtime", runtime.versionElement, () => parseChromeVersionElement(runtime.versionElement));
  const executable = parse("runtime.executable-version", "runtime", runtime.executableFullVersion, () => parseChromiumFullVersion(runtime.executableFullVersion));
  add("runtime.version-source", "runtime", runtime.versionElementSource === "chrome://version#version", "chrome://version#version", runtime.versionElementSource, "Page body/fallback is not an independent version element");
  add("runtime.version-tuple", "runtime", Boolean(product && element && executable && product.version === element.version && element.version === executable.version),
    executable?.version, { product: product?.version, element: element?.version }, "Runtime product, exact version element, and executable full version must agree");
  const runtimeVersion = executable;
  const uaHost = (ua: string): boolean => hostPlatform === "MacIntel" ? /Macintosh;[^)]*Mac OS X/.test(ua) && !/Windows NT|Android/.test(ua) :
    hostPlatform === "Win32" && /Windows NT/.test(ua) && !/Macintosh|Android/.test(ua);
  const verifyUa = (id: string, value: unknown): void => {
    const version = parse(`${id}.format`, "runtime", value, () => parseChromiumUserAgentVersion(value as string));
    const allowed = runtimeVersion && [runtimeVersion.version, ...(contract.mode === "off" ? [`${runtimeVersion.major}.0.0.0`] : [])];
    add(`${id}.runtime`, "runtime", Boolean(version && allowed?.includes(version.version) && uaHost(value as string) &&
      (!version.product.startsWith("Headless") || runtime.binding?.mode === "headless")), allowed, value, "Observed UA must match the host and independent runtime version (native reduction only in off mode)");
  };
  add("runtime.product-mode", "runtime", Boolean(product && (!product.product.startsWith("Headless") || runtime.binding?.mode === "headless")), runtime.binding?.mode, product?.product, "Headless product is not valid for a headed receipt");
  verifyUa("runtime.cdp-user-agent", runtime.userAgent);
  const managed = contract.expectedManaged;
  const expected = managed ? {
    userAgent: managed.userAgent, platform: managed.platform, uaPlatform: managed.uaPlatform ?? uaPlatform,
    architecture: managed.architecture ?? "x86", bitness: managed.bitness ?? "64", platformVersion: managed.platformVersion,
    model: managed.model ?? "", mobile: managed.mobile ?? false, wow64: managed.wow64 ?? false,
    realBrands: sorted(managed.realBrands ?? ["Chromium", "Google Chrome"]), formFactors: sorted(managed.formFactors ?? ["Desktop"]),
  } : undefined;
  if (contract.mode === "managed") {
    add("managed-config.present", "managed-config", Boolean(expected), "explicit configured managed identity", managed, "Managed expectation is required, never inferred from the observed UA");
    if (requiresNativeCpu) add("managed-native-cpu.expected", "native-hardware",
      (managed?.architecture === "arm" || managed?.architecture === "x86") && managed.bitness === "64",
      "explicit arm/x86 architecture and 64-bit expectation", { architecture: managed?.architecture, bitness: managed?.bitness },
      "CPU truthfulness requires explicit expectations, not the legacy x86/64 persona defaults");
    if (expected) {
      const version = parse("managed-config.ua-format", "managed-config", expected.userAgent, () => parseChromiumUserAgentVersion(expected.userAgent));
      add("managed-config.runtime-version", "managed-config", Boolean(version && runtimeVersion && version.version === runtimeVersion.version), runtimeVersion?.version, version?.version, "Configured UA is stale relative to the independent executable version");
    }
  }
  let controlOK = false;
  if (input.nativeControl && control) {
    add("native-control.identity", "runtime", control.status === "PASS", "strict off-control identity PASS", control.status, "Native control must pass its own independent identity checks first");
    controlOK = add("native-control.binding", "runtime", control.status === "PASS" && bindingOK && bindingValid(input.nativeControl.runtime.binding) &&
      same(bindingFields(runtime.binding, true), bindingFields(input.nativeControl.runtime.binding, true)) &&
      input.nativeControl.runtime.executableFullVersion === runtime.executableFullVersion,
    bindingValid(runtime.binding) ? bindingFields(runtime.binding, true) : runtime.binding, input.nativeControl.runtime?.binding,
    "Control must share batch/run, host, executable/hash and window mode; its profile/PID/identity mode may differ");
  }
  const nativeCpu = input.nativeControl?.actual?.window?.highEntropy;
  const nativeBinding = input.nativeControl?.runtime?.binding;
  let nativeCpuOK = false;
  if (requiresNativeCpu) nativeCpuOK = add("native-cpu.control", "native-hardware", controlOK &&
    bindingValid(nativeBinding) && bindingValid(runtime.binding) && nativeBinding.pid !== runtime.binding.pid &&
    nativeBinding.profileId !== runtime.binding.profileId && (nativeCpu?.architecture === "arm" || nativeCpu?.architecture === "x86") && nativeCpu.bitness === "64",
  "strict same-run/host/executable/window-mode off control, separate PID/profile, native arm/x86 and 64-bit metadata",
  { identity: control?.status, binding: nativeBinding, architecture: nativeCpu?.architecture, bitness: nativeCpu?.bitness },
  "CPU authority is absent, invalid, not independently bound, or not a separate native process/profile");
  const requiredHints = HINTS.filter((hint) => hint[0] !== "uaFullVersion" && hint[0] !== "uaFormFactors" ||
    (hint[0] === "uaFullVersion" ? contract.optionalHints?.uaFullVersion : contract.optionalHints?.formFactors));
  const ready = new Map<IdentityContext, boolean>();
  const blocked = new Set<IdentityContext>();
  const negotiations = new Map<IdentityContext, unknown>();
  for (const context of IDENTITY_CONTEXTS) {
    const evidence = actual.requestEvidence?.[context];
    const n = evidence?.negotiation;
    const negotiation = parse(`request.${context}.negotiation`, "prerequisite", n, () => {
      if (!record(n) || ["secureContext", "optInResponseReceived", "postOptInRequest", "permissionsPolicyDelegated"].some((key) => typeof n[key] !== "boolean")) return problem("Missing explicit negotiation prerequisites");
      const origin = canonicalOrigin(n.origin), topLevelOrigin = canonicalOrigin(n.topLevelOrigin);
      if ((context === "cross-origin-frame") === (origin === topLevelOrigin)) return problem("Context origin relation is invalid");
      return { origin, topLevelOrigin, secureContext: n.secureContext, optInResponseReceived: n.optInResponseReceived,
        postOptInRequest: n.postOptInRequest, permissionsPolicyDelegated: n.permissionsPolicyDelegated,
        acceptCH: hintNames(n.acceptCH), delegatedHints: hintNames(n.delegatedHints) };
    });
    if (!negotiation) { ready.set(context, false); continue; }
    negotiations.set(context, negotiation);
    const missing = [
      ...(!negotiation.secureContext ? ["secure context"] : []), ...(!negotiation.optInResponseReceived ? ["actual Accept-CH response"] : []),
      ...(!negotiation.postOptInRequest ? ["post-opt-in request"] : []),
      ...requiredHints.filter((hint) => !["uaBrands", "uaMobile", "uaPlatform"].includes(hint[0]) && !negotiation.acceptCH.includes(hint[1])).map((hint) => `Accept-CH ${hint[1]}`),
      ...(context === "cross-origin-frame" ? [
        ...(!negotiation.permissionsPolicyDelegated ? ["Permissions-Policy delegation"] : []),
        ...requiredHints.filter((hint) => !negotiation.delegatedHints.includes(hint[1])).map((hint) => `delegated ${hint[1]}`),
      ] : []),
    ];
    ready.set(context, !missing.length);
    if (missing.length && frameContext(context)) {
      blocked.add(context);
      defer(`request.${context}.prerequisites`, "prerequisite", "BLOCKED", negotiation, `Explicit fixture prerequisites unavailable: ${missing.join(", ")}`);
    } else add(`request.${context}.prerequisites`, "prerequisite", !missing.length, "secure, opted-in, post-negotiation request", negotiation, `Missing prerequisites: ${missing.join(", ")}`);
  }
  const identities = new Map<IdentityContext, Record<string, unknown>>();
  for (const context of IDENTITY_CONTEXTS) {
    const captured = actual.navigators?.[context];
    if (!capture(`navigator.${context}.capture`, captured, blocked.has(context))) continue;
    const nav = captured?.identity;
    const shape = add(`navigator.${context}.shape`, "capture", record(nav) && present(nav.userAgent) && present(nav.platform) && present(nav.uaPlatform) &&
      typeof nav.mobile === "boolean" && record(nav.highEntropy), "typed navigator and high-entropy identity", nav, "Missing or malformed navigator fields");
    if (!shape || !nav || !nav.highEntropy) continue;
    const high = nav.highEntropy;
    const lowBrands = parse(`navigator.${context}.brands`, "coherence", nav.brands, () => brands(nav.brands, false));
    const fullBrands = parse(`navigator.${context}.fullVersionList`, "coherence", high.fullVersionList, () => brands(high.fullVersionList, true));
    for (const [field, valid] of [
      ["architecture", present(high.architecture)], ["bitness", high.bitness === "32" || high.bitness === "64"],
      ["platformVersion", typeof high.platformVersion === "string" && high.platformVersion === high.platformVersion.trim() && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(high.platformVersion)],
      ["model", typeof high.model === "string"], ["wow64", typeof high.wow64 === "boolean"],
    ] as const) add(`navigator.${context}.${field}`, "coherence", valid, `present typed ${field}`, high[field], `Missing or malformed high-entropy ${field}; empty model and false wow64 are valid present values`);
    add(`navigator.${context}.host`, "coherence", nav.platform === hostPlatform && nav.uaPlatform === uaPlatform && high.platform === uaPlatform && nav.mobile === false &&
      (high.mobile === undefined || high.mobile === nav.mobile), { platform: hostPlatform, uaPlatform, mobile: false }, nav, "Navigator desktop host/platform/mobile surfaces conflict");
    verifyUa(`navigator.${context}.user-agent`, nav.userAgent);
    add(`navigator.${context}.brand-versions`, "runtime", Boolean(runtimeVersion && lowBrands && fullBrands &&
      lowBrands.every((item) => item.version === runtimeVersion.major) && fullBrands.every((item) => item.version === runtimeVersion.version) &&
      same(lowBrands.map((item) => item.brand), fullBrands.map((item) => item.brand))), runtimeVersion?.version,
    { low: lowBrands, full: fullBrands }, "Real low/full brands must have matching sets and actual runtime major/full versions");
    if (high.brands !== undefined) {
      const highBrands = parse(`navigator.${context}.high-brands`, "coherence", high.brands, () => brands(high.brands, false));
      add(`navigator.${context}.high-low-brands`, "coherence", Boolean(highBrands && lowBrands && same(highBrands, lowBrands)), lowBrands, highBrands, "High/low entropy real brands conflict");
    }
    if (contract.optionalHints?.uaFullVersion || high.uaFullVersion !== undefined) {
      const full = parse(`navigator.${context}.uaFullVersion`, "coherence", high.uaFullVersion, () => parseChromiumFullVersion(high.uaFullVersion as string));
      add(`navigator.${context}.uaFullVersion.runtime`, "runtime", Boolean(full && runtimeVersion && full.version === runtimeVersion.version), runtimeVersion?.version, high.uaFullVersion, "uaFullVersion must be the actual runtime full version");
    }
    let formFactors: string[] | undefined;
    if (contract.optionalHints?.formFactors || high.formFactors !== undefined) formFactors = parse(`navigator.${context}.formFactors`, "coherence", high.formFactors, () => stringSet(high.formFactors));
    const identity = { userAgent: nav.userAgent, platform: nav.platform, uaPlatform: nav.uaPlatform, mobile: nav.mobile,
      brands: lowBrands, architecture: high.architecture, bitness: high.bitness, platformVersion: high.platformVersion,
      fullVersionList: fullBrands, model: high.model, wow64: high.wow64, uaFullVersion: high.uaFullVersion, formFactors };
    identities.set(context, identity);
    if (contract.mode === "managed" && expected) {
      const observed = { userAgent: nav.userAgent, platform: nav.platform, uaPlatform: nav.uaPlatform, architecture: high.architecture,
        bitness: high.bitness, platformVersion: high.platformVersion, model: high.model, mobile: nav.mobile, wow64: high.wow64,
        realBrands: fullBrands?.map((item) => item.brand), formFactors: formFactors !== undefined || contract.optionalHints?.formFactors ? formFactors : expected.formFactors };
      add(`navigator.${context}.managed-config`, "managed-config", same(observed, expected), expected, observed, "Coherent observed identity does not fulfill configured managed metadata");
    }
    if (requiresNativeCpu) add(`navigator.${context}.native-cpu`, "native-hardware", nativeCpuOK &&
      high.architecture === nativeCpu?.architecture && high.bitness === nativeCpu?.bitness,
    { architecture: nativeCpu?.architecture, bitness: nativeCpu?.bitness }, { architecture: high.architecture, bitness: high.bitness },
    "Configured/coherent CPU metadata must also match the independently validated native CPU control");
  }
  const windowIdentity = identities.get("window");
  for (const [context, identity] of identities) add(`navigator.${context}.cross-surface`, "coherence", Boolean(windowIdentity && same(identity, windowIdentity)), windowIdentity, identity, "Navigator surfaces disagree (real brand order/GREASE excluded)");
  for (const [alias, context] of [["window", "window"], ["worker", "dedicated"]] as const) {
    const view = parse(`navigator.${alias}.legacy-alias.format`, "coherence", actual[alias], () => {
      const nav = actual[alias], high = nav?.highEntropy;
      if (!nav || !record(high)) return problem("Legacy alias navigator is missing");
      return { userAgent: nav.userAgent, platform: nav.platform, uaPlatform: nav.uaPlatform, mobile: nav.mobile,
        brands: brands(nav.brands, false), architecture: high.architecture, bitness: high.bitness, platformVersion: high.platformVersion,
        fullVersionList: brands(high.fullVersionList, true), model: high.model, wow64: high.wow64, uaFullVersion: high.uaFullVersion,
        formFactors: high.formFactors === undefined ? undefined : stringSet(high.formFactors) };
    });
    add(`navigator.${alias}.legacy-alias`, "coherence", Boolean(view && identities.has(context) && same(view, identities.get(context))),
      identities.get(context), view, "Legacy corpus alias disagrees with its named captured context");
  }
  add("runtime.cdp-window-coherence", "coherence", Boolean(windowIdentity && runtime.userAgent === windowIdentity.userAgent), windowIdentity?.userAgent, runtime.userAgent, "CDP userAgent is another observed surface, not the runtime oracle");
  for (const context of IDENTITY_CONTEXTS) {
    const evidence = actual.requestEvidence?.[context];
    if (!capture(`request.${context}.capture`, evidence, blocked.has(context))) continue;
    add(`request.${context}.success`, "capture", typeof evidence?.responseStatus === "number" && evidence.responseStatus >= 200 && evidence.responseStatus < 300,
      "successful 2xx response", evidence?.responseStatus, "A missing/failed request cannot establish hint behavior");
    const requestOrigin = parse(`request.${context}.origin`, "prerequisite", evidence?.requestUrl, () => {
      if (!present(evidence?.requestUrl)) return problem("Missing actual request URL");
      try { return new URL(evidence.requestUrl).origin; } catch (error) { if (error instanceof TypeError) return problem("Invalid request URL"); throw error; }
    });
    add(`request.${context}.origin-binding`, "prerequisite", Boolean(requestOrigin && requestOrigin === evidence?.negotiation?.origin), evidence?.negotiation?.origin, requestOrigin, "Request does not belong to the negotiated origin");
    const headers = actual.requestHeaders?.[context];
    if (!add(`request.${context}.headers`, "capture", record(headers), "actual captured request headers", headers, "Request header capture is absent or malformed") || !headers) continue;
    const nav = identities.get(context);
    add(`request.${context}.user-agent`, "coherence", Boolean(nav && present(headers.userAgent) && headers.userAgent === nav.userAgent), nav?.userAgent, headers.userAgent, "Successful request must send the captured context's UA, including when hints are omitted");
    verifyUa(`request.${context}.user-agent`, headers.userAgent);
    const omitted = HINTS.every(([key]) => Object.hasOwn(headers, key) && headers[key] === null);
    let allowedOmission = false;
    if (omitted && workerContext(context) && contract.workerHintPolicy === "native-control-omission" && ready.get(context)) {
      const nativeHeaders = input.nativeControl?.actual?.requestHeaders?.[context];
      const nativeEvidence = input.nativeControl?.actual?.requestEvidence?.[context];
      const nativeNegotiation = nativeEvidence?.negotiation;
      let equivalent = false;
      if (controlOK && nativeNegotiation) {
        const normalised = parse(`request.${context}.native-negotiation`, "prerequisite", nativeNegotiation, () => ({
          ...nativeNegotiation, acceptCH: hintNames(nativeNegotiation.acceptCH), delegatedHints: hintNames(nativeNegotiation.delegatedHints),
        }));
        equivalent = same(negotiations.get(context), normalised);
      }
      const successfulRequest = bindingOK && evidence?.responseStatus !== undefined && evidence.responseStatus >= 200 && evidence.responseStatus < 300 &&
        requestOrigin === evidence.negotiation?.origin && Boolean(nav) && headers.userAgent === nav?.userAgent;
      allowedOmission = successfulRequest && (controlRole || Boolean(controlOK && equivalent && nativeHeaders &&
        HINTS.every(([key]) => Object.hasOwn(nativeHeaders, key) && nativeHeaders[key] === null)));
      add(`request.${context}.omission-shape`, "omission", allowedOmission, "successful complete omission matching a valid same-run/host/executable/window-mode native control and negotiation",
        { omitted, control: control?.status, equivalentNegotiation: equivalent, nativeHeaders }, "Missing hints are not an allowed native omission shape");
    } else add(`request.${context}.hint-shape`, "omission", requiredHints.every(([key]) => typeof headers[key] === "string"),
      "complete required negotiated hint values (or predeclared valid worker omission)", headers, "Complete or partial hint absence is not permitted for this context/control/policy");
    const checkedHints = HINTS.filter((hint) => requiredHints.includes(hint) || headers[hint[0]] !== null && headers[hint[0]] !== undefined);
    for (const [key, , field, encoding] of checkedHints) {
      if (allowedOmission) {
        defer(`request.${context}.${key}`, "coherence", "NOTRUN", headers[key], "Complete worker hint omission matches a strictly validated native control; no absent value was verified", true);
        if (requiresNativeCpu && (field === "architecture" || field === "bitness")) defer(`request.${context}.${key}.native-cpu`, "native-hardware", "NOTRUN", headers[key],
          "Native worker HTTP CPU hint is absent; navigator CPU values are checked separately, no absent header value was verified", true);
        continue;
      }
      const value = parse(`request.${context}.${key}.format`, "coherence", headers[key], () => {
        const text = headers[key];
        if (typeof text !== "string") return problem(`Missing required ${key} header`);
        if (encoding === "brands" || encoding === "full-brands") return brands(parseClientHintBrands(text), encoding === "full-brands");
        if (encoding === "boolean") return parseClientHintBoolean(text);
        if (encoding === "strings") return stringSet(parseClientHintFormFactors(text));
        return parseClientHintString(text);
      });
      add(`request.${context}.${key}.value`, "coherence", value !== undefined && Boolean(nav) && same(value, nav?.[field]), nav?.[field], value, "Actual negotiated header value disagrees with navigator identity");
      if (requiresNativeCpu && (field === "architecture" || field === "bitness")) add(`request.${context}.${key}.native-cpu`, "native-hardware",
        nativeCpuOK && value !== undefined && same(value, nativeCpu?.[field]), nativeCpu?.[field], value,
        "Actual negotiated CPU hint must match the independently validated native CPU control");
    }
  }
  const legacyShape = actual.window && actual.worker && record(actual.window.highEntropy) && record(actual.worker.highEntropy) &&
    ["window", "dedicated", "shared", "service"].every((context) => record(actual.requestHeaders?.[context as "window"]));
  if (legacyShape && hostPlatform) {
    try {
      verifyHostIdentityCoherence(actual, { userAgent: actual.window.userAgent, platform: hostPlatform }, contract.hostPlatform,
        "full identity core coherence", controlRole ? actual : controlOK ? input.nativeControl?.actual : undefined);
      add("coherence.legacy-core", "coherence", true, "legacy host/UA/high-entropy core agreement", "verified", "");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      add("coherence.legacy-core", "coherence", false, "legacy host/UA/high-entropy core agreement", error.message, error.message);
    }
  } else add("coherence.legacy-core", "coherence", false, "complete legacy core fields", actual, "Core identity is incomplete; old partial input cannot satisfy the full gate");
  const required = assertions.filter((assertion) => assertion.required);
  const status: IdentityStatus = required.some((assertion) => assertion.status === "FAIL") ? "FAIL" :
    required.some((assertion) => assertion.status === "BLOCKED") ? "BLOCKED" :
    required.some((assertion) => assertion.status !== "PASS") ? "NOTRUN" : "PASS";
  return { status, assertions, ...(runtimeVersion ? { runtimeVersion: runtimeVersion.version } : {}), ...(control ? { nativeControl: control } : {}) };
}
export function verifyFullHostIdentity(input: FullHostIdentityInput): void {
  const result = validateFullHostIdentity(input);
  if (result.status !== "PASS") throw new Error(`Full host identity ${result.status}: ${result.assertions.filter((item) => item.required && item.status !== "PASS").map((item) => `${item.id}: ${item.reasons.join("; ")}`).join(" | ")}`);
}
