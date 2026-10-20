import type { BrowserEngine } from "../main/types.js";
import type { ProfileRuntimeIdentityState } from "../main/services/profile-identity.js";
import type { FullHostIdentityCapture, PartialHostIdentityCapture } from "./host-identity-capture.js";
import { IDENTITY_CONTEXTS, type IdentityRunBinding } from "./host-identity-validation.js";
import { isChromiumGreaseBrand, parseClientHintBrands } from "./client-hints.js";

/** Supply independently observed production process/version/policy facts, not
 * profile settings or a retained fingerprintBaseline. The comparison does not
 * inspect the machine, start a browser, or authenticate caller-supplied facts. */
export interface ProfileIdentityRuntimeReceipt {
  engine: BrowserEngine;
  binding: IdentityRunBinding;
  verifiedBinding: IdentityRunBinding;
  executableVersion: string;
  browserVersion: string;
  browserVersionSource: "cdp" | "bidi";
  /** Versioned non-secret policy projection including effective identity, GPU,
   * DNS, render and injection policies. NOT raw argv or a hash of credentials.
   * Exclude run IDs, profile paths and ports; preserve effective policy values. */
  launchPolicyHash: string;
}
export interface ProfileIdentityRuntimeSample {
  capture: FullHostIdentityCapture | PartialHostIdentityCapture;
  runtime: ProfileIdentityRuntimeReceipt;
}
type Value = null | string | number | boolean | Value[] | { [key: string]: Value };
export interface ProfileIdentityRuntimeComparison {
  version: 1;
  state: Exclude<ProfileRuntimeIdentityState, "not-verified">;
  scope: "six-context-navigator-and-identity-headers";
  /** This lane does not capture fonts, GPU/canvas/audio, timezone, etc. */
  fullFingerprintVerified: false;
  differences: Array<{ path: string; before: Value; after: Value }>;
  issues: string[];
  actual: { before: RuntimeFacts | null; after: RuntimeFacts | null };
  excludedObservations: typeof PROFILE_IDENTITY_VOLATILE_EXCLUSIONS;
  unobservedSurfaces: readonly string[];
}
interface RuntimeFacts {
  engine: BrowserEngine; hostId: string; executableSha256: string; executableVersion: string;
  mode: "headed" | "headless"; identityMode: "managed" | "off"; launchPolicyHash: string;
}
export const PROFILE_IDENTITY_VOLATILE_EXCLUSIONS = [
  { path: "binding.runId/profileId/pid", rationale: "A restored profile/restarted process has new ownership IDs; each capture must still match its independently verified binding." },
  { path: "fixture URLs/origins/ports/random capture paths", rationale: "Owned dynamic fixture addresses are routing, not browser identity; exact local topology and receipt URLs are checked within each run." },
  { path: "wire.sequence and cross-context request order", rationale: "Scheduling is not identity; unique receipt sequences and opt-in-before-echo are still required." },
  { path: "raw header name casing/order", rationale: "Raw receipts must agree with normalized wire headers; HTTP field casing/order is not an identity value." },
  { path: "UA-CH GREASE members and brand-list ordering", rationale: "Only the existing strict Chromium GREASE spelling/version pool is excluded; all real brand/version members remain compared as an unordered roster." },
  { path: "non-identity HTTP headers and response Date/connection bookkeeping", rationale: "Compare the fixed UA/language/DNT/client-hints boundary, not transient routing/HTTP transport metadata; credentials are rejected, never ignored." },
  { path: "capture timeout budget and warning text", rationale: "Runner bookkeeping is not identity; failed/incomplete capture or cleanup is never eligible for equivalence." },
] as const;
const UNOBSERVED = [
  "GPU/WebGL/WebGPU capabilities and host OS acceptance (OS coherence alone is not full identity)",
  "Fonts/extension package bytes, canvas/audio, screen/raster geometry and storage identity",
  "Timezone/geolocation/exit-IP, DNS/WebRTC/rAF/time behavior and other uncaptured surfaces",
  "Cookies, credentials, account/session data (not part of this lane)",
] as const;
const HEADER_FIELDS = {
  userAgent: "user-agent", acceptLanguage: "accept-language", doNotTrack: "dnt",
  uaBrands: "sec-ch-ua", uaMobile: "sec-ch-ua-mobile", uaPlatform: "sec-ch-ua-platform",
  uaArchitecture: "sec-ch-ua-arch", uaBitness: "sec-ch-ua-bitness", uaPlatformVersion: "sec-ch-ua-platform-version",
  uaFullVersionList: "sec-ch-ua-full-version-list", uaFullVersion: "sec-ch-ua-full-version",
  uaModel: "sec-ch-ua-model", uaWow64: "sec-ch-ua-wow64", uaFormFactors: "sec-ch-ua-form-factors",
} as const;
const BINDING_FIELDS = ["runId", "hostId", "profileId", "pid", "executablePath", "executableSha256", "mode", "identityMode"] as const;
const HIGH_ENTROPY_FIELDS = ["architecture", "bitness", "platform", "platformVersion", "fullVersionList", "uaFullVersion", "model", "wow64", "mobile", "formFactors", "brands"] as const;
const FORBIDDEN_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);
const SHA256 = /^[a-f0-9]{64}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 16384; }
function ordered(value: unknown): unknown {
  return Array.isArray(value) ? value.map(ordered) : record(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right)); }
function requireFact(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function binding(value: unknown): IdentityRunBinding {
  requireFact(record(value) && ["runId", "hostId", "profileId", "executablePath"].every((key) => text(value[key])) &&
    Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.executableSha256 === "string" && SHA256.test(value.executableSha256) &&
    ["headed", "headless"].includes(String(value.mode)) && ["managed", "off"].includes(String(value.identityMode)), "invalid-binding");
  return value as unknown as IdentityRunBinding;
}
function stringList(value: unknown): string[] {
  requireFact(Array.isArray(value) && value.length <= 32 && value.every(text) && new Set(value).size === value.length, "invalid-string-list");
  return [...value].sort();
}
function hintNames(value: unknown): string[] {
  const names = stringList(value).map((name) => name.toLowerCase());
  requireFact(names.every((name) => /^sec-ch-[a-z0-9-]+$/.test(name)) && new Set(names).size === names.length, "invalid-hint-names");
  return names.sort();
}
function brandList(value: unknown): Value[] {
  requireFact(Array.isArray(value) && value.length > 0 && value.length <= 32, "invalid-brands");
  const seen = new Set<string>();
  const brands = value.map((entry) => {
    requireFact(record(entry) && text(entry.brand) && text(entry.version) && !seen.has(entry.brand), "invalid-brand-member");
    seen.add(entry.brand); return { brand: entry.brand, version: entry.version };
  });
  const real = brands.filter((entry) => !isChromiumGreaseBrand(entry));
  requireFact(real.length > 0, "missing-real-brands");
  return real.sort((a, b) => a.brand < b.brand ? -1 : a.brand > b.brand ? 1 : 0);
}
function navigatorValues(value: unknown): Record<string, Value> {
  requireFact(record(value) && text(value.userAgent) && text(value.platform) &&
    (value.uaPlatform === null || typeof value.uaPlatform === "string") &&
    (value.mobile === null || typeof value.mobile === "boolean") && Object.hasOwn(value, "brands"), "invalid-navigator");
  const result: Record<string, Value> = { userAgent: value.userAgent, platform: value.platform,
    uaPlatform: value.uaPlatform, mobile: value.mobile, brands: value.brands === null ? null : brandList(value.brands) };
  if (value.highEntropy === null) result.highEntropy = null;
  else {
    requireFact(record(value.highEntropy), "missing-high-entropy-observation");
    requireFact(Object.keys(value.highEntropy).every((key) => (HIGH_ENTROPY_FIELDS as readonly string[]).includes(key)), "unknown-high-entropy-field");
    const high: Record<string, Value> = {};
    for (const field of HIGH_ENTROPY_FIELDS) {
      const member = value.highEntropy[field];
      if (member === undefined) continue; // Observed native omission, never filled from another context.
      if (field === "brands" || field === "fullVersionList") high[field] = brandList(member);
      else if (field === "formFactors") high[field] = stringList(member);
      else {
        requireFact(typeof member === (field === "wow64" || field === "mobile" ? "boolean" : "string"), "invalid-high-entropy-value");
        high[field] = member as string | boolean;
      }
    }
    result.highEntropy = high;
  }
  return result;
}
function headerMap(value: unknown, raw: unknown): Record<string, string> {
  requireFact(record(value) && Object.keys(value).length <= 64 && Array.isArray(raw) && raw.length <= 128 && raw.length % 2 === 0, "invalid-wire-headers");
  const headers: Record<string, string> = {}, original: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    requireFact(!FORBIDDEN_HEADERS.has(key.toLowerCase()), "credentials-forbidden");
    requireFact(key === key.toLowerCase() && /^[a-z0-9-]+$/.test(key) && typeof member === "string" && member.length <= 16384, "invalid-wire-header");
    headers[key] = member;
  }
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index], member = raw[index + 1];
    requireFact(typeof key === "string" && typeof member === "string", "invalid-raw-header");
    const lower = key.toLowerCase();
    requireFact(!FORBIDDEN_HEADERS.has(lower), "credentials-forbidden");
    requireFact(/^[a-z0-9-]+$/.test(lower) && member.length <= 16384, "invalid-raw-header");
    requireFact(!Object.hasOwn(original, lower), "duplicate-raw-header");
    original[lower] = member;
  }
  requireFact(same(headers, original), "raw-normalized-header-mismatch");
  return headers;
}
function identityHeaders(headers: Record<string, string>): Record<string, Value> {
  const selected: Record<string, Value> = {};
  for (const [field, name] of Object.entries(HEADER_FIELDS)) {
    const value = headers[name] ?? null;
    selected[field] = value !== null && (field === "uaBrands" || field === "uaFullVersionList")
      ? brandList(parseClientHintBrands(value)) : value;
  }
  requireFact(text(selected.userAgent), "missing-wire-user-agent");
  return selected;
}
function fixtureUrl(value: unknown, phase: "opt-in" | "echo", context: string): URL {
  requireFact(text(value), "missing-wire-url");
  const url = new URL(value);
  requireFact(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && !url.username && !url.password && !url.hash &&
    /^\/__host_identity_[a-f0-9-]+\/[a-f0-9-]+\/(?:opt-in|echo)$/.test(url.pathname) &&
    url.pathname.endsWith(`/${phase}`) && url.search === `?context=${context}`, "unowned-wire-url");
  return url;
}
interface Projection { facts: RuntimeFacts; executablePath: string; runId: string; fields: Record<string, Value> }
function project(input: unknown): Projection {
  requireFact(record(input) && record(input.capture) && record(input.runtime), "missing-live-sample");
  const capture = input.capture, receipt = input.runtime;
  const observed = binding(capture.binding), declared = binding(receipt.binding), verified = binding(receipt.verifiedBinding);
  requireFact(BINDING_FIELDS.every((key) => observed[key] === verified[key] && declared[key] === verified[key]), "unverified-process-binding");
  requireFact(receipt.engine === "chromium" || receipt.engine === "firefox", "invalid-engine");
  const versionPattern = receipt.engine === "chromium" ? /^\d+\.\d+\.\d+\.\d+$/ : /^\d+(?:\.\d+){0,2}$/;
  requireFact(typeof receipt.executableVersion === "string" && versionPattern.test(receipt.executableVersion) &&
    receipt.browserVersion === receipt.executableVersion && receipt.browserVersionSource === (receipt.engine === "chromium" ? "cdp" : "bidi"), "unverified-actual-version");
  requireFact(typeof receipt.launchPolicyHash === "string" && SHA256.test(receipt.launchPolicyHash), "missing-launch-policy");
  requireFact(record(capture.captureEvidence) && Array.isArray(capture.captureEvidence.cleanupErrors) && capture.captureEvidence.cleanupErrors.length === 0 &&
    record(capture.captureEvidence.contexts) && Array.isArray(capture.captureEvidence.wire) && capture.captureEvidence.wire.length === IDENTITY_CONTEXTS.length * 2,
  "incomplete-capture-or-cleanup");
  requireFact(record(capture.navigators) && record(capture.requestEvidence) && record(capture.requestHeaders), "missing-six-context-capture");
  const wire = capture.captureEvidence.wire;
  requireFact(wire.every((entry) => record(entry) && IDENTITY_CONTEXTS.includes(entry.context as typeof IDENTITY_CONTEXTS[number]) &&
    (entry.phase === "opt-in" || entry.phase === "echo") && Number.isSafeInteger(entry.sequence) && Number(entry.sequence) >= 0) &&
    new Set(wire.map((entry) => entry.sequence)).size === wire.length, "invalid-wire-inventory");
  const fields: Record<string, Value> = {}, origins: Record<string, string> = {};
  const capturePrefixes = new Set<string>();
  for (const context of IDENTITY_CONTEXTS) {
    const nav = capture.navigators[context], request = capture.requestEvidence[context], surface = capture.captureEvidence.contexts[context];
    requireFact(record(nav) && nav.status === "captured" && record(request) && request.status === "captured" && request.responseStatus === 200 &&
      record(surface) && surface.context === context && record(surface.navigator) && surface.navigator.status === "captured" &&
      record(surface.request) && surface.request.status === "captured", `incomplete-context:${context}`);
    const navigator = navigatorValues(nav.identity);
    requireFact(same(navigator, navigatorValues(surface.navigator.identity)) && same(request, surface.request), `surface-capture-mismatch:${context}`);
    requireFact(record(surface.observation) && surface.observation.secureContext === true &&
      ["permissionsPolicy", "featurePolicy", "unavailable"].includes(String(surface.observation.api)) && record(request.negotiation) &&
      request.negotiation.secureContext === true, `missing-policy:${context}`);
    const negotiation = request.negotiation;
    const receipts = wire.filter((entry) => entry.context === context);
    const warm = receipts.find((entry) => entry.phase === "opt-in"), echo = receipts.find((entry) => entry.phase === "echo");
    requireFact(receipts.length === 2 && warm && echo && warm.sequence < echo.sequence && warm.responseStatus === 200 && echo.responseStatus === 200 &&
      record(warm.responseHeaders) && record(echo.responseHeaders), `missing-wire-receipt:${context}`);
    const warmUrl = fixtureUrl(warm.requestUrl, "opt-in", context), echoUrl = fixtureUrl(echo.requestUrl, "echo", context);
    requireFact(warmUrl.origin === echoUrl.origin && warmUrl.pathname.slice(0, -6) === echoUrl.pathname.slice(0, -4) &&
      request.requestUrl === echo.requestUrl && negotiation.origin === echoUrl.origin && surface.observation.origin === echoUrl.origin,
    `wire-origin-mismatch:${context}`);
    origins[context] = echoUrl.origin; capturePrefixes.add(echoUrl.pathname.slice(0, -4));
    requireFact(record(surface.optIn) && surface.optIn.url === warm.requestUrl && surface.optIn.status === 200 && record(surface.optIn.headers) &&
      record(surface.echo) && surface.echo.url === echo.requestUrl && surface.echo.status === 200 && record(surface.echoed) &&
      surface.optIn.headers["accept-ch"] === warm.responseHeaders["accept-ch"] &&
      surface.optIn.headers["permissions-policy"] === warm.responseHeaders["permissions-policy"] &&
      same(surface.echoed, { requestUrl: echo.requestUrl, headers: echo.headers, rawHeaders: echo.rawHeaders }), `wire-response-mismatch:${context}`);
    const warmHeaders = headerMap(warm.headers, warm.rawHeaders), echoHeaders = headerMap(echo.headers, echo.rawHeaders);
    requireFact(record(capture.requestHeaders[context]), `missing-selected-headers:${context}`);
    const selected = capture.requestHeaders[context];
    requireFact(Object.entries(HEADER_FIELDS).every(([field, name]) => (selected[field] ?? null) === (echoHeaders[name] ?? null)), `selected-wire-mismatch:${context}`);
    fields[`${context}.navigator`] = navigator;
    fields[`${context}.wire.opt-in`] = identityHeaders(warmHeaders);
    fields[`${context}.wire.echo`] = identityHeaders(echoHeaders);
    fields[`${context}.policy`] = {
      secureContext: true, api: String(surface.observation.api),
      allowedHints: hintNames(surface.observation.allowedHints),
      crossOriginAllowedHints: hintNames(surface.observation.crossOriginAllowedHints),
      acceptCH: hintNames(negotiation.acceptCH),
      delegatedHints: hintNames(negotiation.delegatedHints),
    };
    for (const field of ["optInResponseReceived", "postOptInRequest", "permissionsPolicyDelegated"] as const) {
      requireFact(typeof negotiation[field] === "boolean", `invalid-negotiation:${context}`);
      fields[`${context}.policy.${field}`] = negotiation[field];
    }
  }
  requireFact(capturePrefixes.size === 1, "mixed-capture-paths");
  for (const context of IDENTITY_CONTEXTS) {
    const evidence = capture.requestEvidence[context];
    requireFact(record(evidence) && record(evidence.negotiation) && evidence.negotiation.topLevelOrigin === origins.window &&
      (context === "cross-origin-frame" ? origins[context] !== origins.window : origins[context] === origins.window), `fixture-topology-mismatch:${context}`);
  }
  return { facts: { engine: receipt.engine, hostId: verified.hostId, executableSha256: verified.executableSha256,
    executableVersion: receipt.executableVersion, mode: verified.mode, identityMode: verified.identityMode, launchPolicyHash: receipt.launchPolicyHash },
    executablePath: verified.executablePath, runId: verified.runId, fields };
}
function flatten(value: Value, prefix: string, output: Record<string, Value>): void {
  if (record(value) && Object.keys(value).length) for (const [key, member] of Object.entries(value)) flatten(member as Value, `${prefix}.${key}`, output);
  else output[prefix] = value;
}

/** Pass the untouched results of captureFullHostIdentity/startHostIdentityFixture.
 * Its own cleanupHostIdentityInPage path and the runner's outer fixture.close()
 * remain mandatory. Firefox's observed null/absent UA-CH is compared as-is.
 * A reverified result proves only this declared observation boundary, NEVER a
 * full fingerprint or the correctness of a host/persona/coherence policy. */
export function compareCapturedProfileIdentity(before: unknown, after: unknown): ProfileIdentityRuntimeComparison {
  const issues: string[] = [];
  const parse = (value: unknown, side: string): Projection | null => {
    try { return project(value); }
    catch (error) {
      // No raw input/headers/credential values enter a failed receipt.
      const code = error instanceof Error && /^[a-z0-9:-]+$/.test(error.message) ? error.message : "invalid-live-evidence";
      issues.push(`${side}:${code}`); return null;
    }
  };
  const left = parse(before, "before"), right = parse(after, "after");
  const result: ProfileIdentityRuntimeComparison = { version: 1, state: "not-verifiable", scope: "six-context-navigator-and-identity-headers",
    fullFingerprintVerified: false, differences: [], issues, actual: { before: left?.facts ?? null, after: right?.facts ?? null },
    excludedObservations: PROFILE_IDENTITY_VOLATILE_EXCLUSIONS, unobservedSurfaces: UNOBSERVED };
  if (!left || !right) return result;
  for (const field of Object.keys(left.facts) as Array<keyof RuntimeFacts>) {
    if (left.facts[field] !== right.facts[field]) issues.push(`precondition:${field}`);
  }
  if (left.executablePath !== right.executablePath) issues.push("precondition:executablePath");
  if (left.runId === right.runId) issues.push("precondition:distinct-capture-runs");
  if (issues.length) return result;
  const beforeFields: Record<string, Value> = {}, afterFields: Record<string, Value> = {};
  for (const [path, value] of Object.entries(left.fields)) flatten(value, path, beforeFields);
  for (const [path, value] of Object.entries(right.fields)) flatten(value, path, afterFields);
  for (const path of [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].sort()) {
    if (!same(beforeFields[path], afterFields[path])) result.differences.push({ path,
      before: Object.hasOwn(beforeFields, path) ? beforeFields[path] : { observation: "absent" },
      after: Object.hasOwn(afterFields, path) ? afterFields[path] : { observation: "absent" } });
  }
  result.state = result.differences.length ? "different" : "reverified";
  return result;
}
