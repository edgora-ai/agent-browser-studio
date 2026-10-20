import { describe, expect, it } from "vitest";
import type { HostIdentityCorpus } from "../../src/tools/host-identity-corpus.js";
import {
  IDENTITY_CONTEXTS, validateFullHostIdentity, verifyFullHostIdentity,
  type FullHostIdentityCorpus, type FullHostIdentityInput, type FullHostIdentityRequestHeaders,
  type FullHostIdentityValidation, type FullHostNavigatorIdentity, type HostIdentityBrand,
  type IdentityContext, type IdentityRunBinding,
} from "../../src/tools/host-identity-validation.js";

// Synthetic, pure fixtures only. These strings are never used to start a process or contact an origin.
const VERSION = "152.0.7977.72";
const HINT_HEADERS = ["uaBrands", "uaMobile", "uaPlatform", "uaArchitecture", "uaBitness", "uaPlatformVersion",
  "uaFullVersionList", "uaModel", "uaWow64", "uaFullVersion", "uaFormFactors"] as const;
const ACCEPT_CH = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-arch", "sec-ch-ua-bitness",
  "sec-ch-ua-platform-version", "sec-ch-ua-full-version-list", "sec-ch-ua-model", "sec-ch-ua-wow64", "sec-ch-ua-full-version", "sec-ch-ua-form-factors"];
const sfBrands = (values: HostIdentityBrand[]): string => values.map(({ brand, version }) => `${JSON.stringify(brand)};v=${JSON.stringify(version)}`).join(", ");
function navigator(input: FullHostIdentityInput, context: IdentityContext = "window"): FullHostNavigatorIdentity {
  return input.actual.navigators![context]!.identity!;
}
function allNavigators(input: FullHostIdentityInput): FullHostNavigatorIdentity[] {
  return IDENTITY_CONTEXTS.map((context) => navigator(input, context));
}
function syncHeaders(input: FullHostIdentityInput): void {
  for (const context of IDENTITY_CONTEXTS) {
    const nav = navigator(input, context), high = nav.highEntropy!;
    input.actual.requestHeaders[context] = {
      userAgent: nav.userAgent, acceptLanguage: "en-US", doNotTrack: "1", uaBrands: sfBrands(nav.brands!),
      uaMobile: nav.mobile ? "?1" : "?0", uaPlatform: JSON.stringify(nav.uaPlatform),
      uaArchitecture: JSON.stringify(high.architecture), uaBitness: JSON.stringify(high.bitness),
      uaPlatformVersion: JSON.stringify(high.platformVersion), uaFullVersionList: sfBrands(high.fullVersionList!),
      uaModel: JSON.stringify(high.model), uaWow64: high.wow64 ? "?1" : "?0",
      uaFullVersion: JSON.stringify(high.uaFullVersion), uaFormFactors: high.formFactors!.map((value) => JSON.stringify(value)).join(", "),
    };
  }
}
function fixture(mode: "managed" | "off" = "managed", host: "darwin" | "win32" = "darwin"): FullHostIdentityInput {
  const platform = host === "darwin" ? "MacIntel" : "Win32", uaPlatform = host === "darwin" ? "macOS" : "Windows";
  const token = host === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64";
  const userAgent = `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${mode === "off" ? "152.0.0.0" : VERSION} Safari/537.36`;
  const realBrands = mode === "managed" ? ["Chromium", "Google Chrome"] : ["Chromium"];
  const low = [...realBrands.map((brand) => ({ brand, version: "152" })), { brand: "Not_A Brand", version: "99" }];
  const full = [...realBrands.map((brand) => ({ brand, version: VERSION })), { brand: "Not_A Brand", version: "99.0.0.0" }];
  const binding: IdentityRunBinding = { runId: "unit-batch-532", hostId: "synthetic-owned-host", profileId: `unit-${mode}`, pid: mode === "managed" ? 42 : 43,
    executablePath: "/synthetic-owned/Chromium", executableSha256: "a".repeat(64), mode: "headed", identityMode: mode };
  const nav: FullHostNavigatorIdentity = { userAgent, platform, uaPlatform, mobile: false, brands: low,
    highEntropy: { platform: uaPlatform, mobile: false, brands: structuredClone(low), architecture: mode === "off" ? "arm" : "x86", bitness: "64",
      platformVersion: host === "win32" ? "10.0.0" : mode === "off" ? "26.3.0" : "15.7.0", model: "", wow64: false,
      fullVersionList: full, uaFullVersion: VERSION, formFactors: ["Desktop"] } };
  const actual = { window: nav, worker: structuredClone(nav), requestHeaders: {}, navigators: {}, requestEvidence: {}, binding: { ...binding } } as FullHostIdentityCorpus;
  for (const context of IDENTITY_CONTEXTS) {
    actual.navigators![context] = { status: "captured", identity: context === "window" ? actual.window : context === "dedicated" ? actual.worker : structuredClone(nav) };
    const origin = context === "cross-origin-frame" ? "https://frame.identity.test" : "https://identity.test";
    actual.requestEvidence![context] = { status: "captured", responseStatus: 200, requestUrl: `${origin}/echo`, negotiation: {
      origin, topLevelOrigin: "https://identity.test", secureContext: true, optInResponseReceived: true, postOptInRequest: true,
      permissionsPolicyDelegated: true, acceptCH: [...ACCEPT_CH], delegatedHints: [...ACCEPT_CH],
    } };
  }
  const result: FullHostIdentityInput = { actual, contract: { mode, hostPlatform: host, optionalHints: { uaFullVersion: true, formFactors: true },
    workerHintPolicy: "native-control-omission", ...(mode === "managed" ? { expectedManaged: {
      userAgent, platform, platformVersion: nav.highEntropy!.platformVersion!,
    } } : {}) }, runtime: { binding: { ...binding }, verifiedBinding: { ...binding }, product: `Chrome/${VERSION}`,
      versionElement: VERSION, versionElementSource: "chrome://version#version", executableFullVersion: VERSION, userAgent } };
  syncHeaders(result);
  return result;
}
function assertion(result: FullHostIdentityValidation, id: string) {
  const found = result.assertions.find((item) => item.id === id);
  expect(found, `missing assertion ${id}`).toBeDefined();
  return found!;
}
function expectPass(input: FullHostIdentityInput): FullHostIdentityValidation {
  const result = validateFullHostIdentity(input);
  expect(result.assertions.filter((item) => item.required && item.status !== "PASS")).toEqual([]);
  expect(result.status).toBe("PASS");
  return result;
}
function omissionFixture(): FullHostIdentityInput {
  const input = fixture(), native = fixture("off");
  input.nativeControl = { actual: native.actual, runtime: native.runtime };
  for (const context of ["dedicated", "shared", "service"] as const) {
    for (const corpus of [input.actual, native.actual]) for (const key of HINT_HEADERS) corpus.requestHeaders[context][key] = null;
  }
  return input;
}
function changeBinding(input: FullHostIdentityInput, key: "runId" | "hostId" | "executableSha256" | "mode", value: string): void {
  for (const binding of [input.actual.binding!, input.runtime.binding, input.runtime.verifiedBinding]) Object.assign(binding, { [key]: value });
}

describe("pure full six-context Chromium identity contract", () => {
  it.each(["darwin", "win32"] as const)("accepts current managed metadata on %s without claiming physical CPU or OS version", (host) => {
    const input = fixture("managed", host);
    expectPass(input);
    expect(() => verifyFullHostIdentity(input)).not.toThrow();
  });
  it("compares HTTP UA-CH platform to the OS family, not navigator.platform", () => {
    const result = expectPass(fixture());
    expect(assertion(result, "request.window.uaPlatform.value")).toMatchObject({ status: "PASS", expected: "macOS", observed: "macOS" });
  });
  it("does not treat an unrecorded new hint as an observed native omission", () => {
    const input = omissionFixture();
    for (const context of ["dedicated", "shared", "service"] as const) {
      for (const corpus of [input.actual, input.nativeControl!.actual]) delete corpus.requestHeaders[context].uaFormFactors;
    }
    expect(validateFullHostIdentity(input).status).toBe("FAIL");
  });
  it("checks observed form factors even when their optional HTTP hint is not required", () => {
    const input = fixture(); input.contract.optionalHints!.formFactors = false;
    for (const nav of allNavigators(input)) nav.highEntropy!.formFactors = ["Mobile"];
    syncHeaders(input);
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("FAIL");
    expect(assertion(result, "navigator.window.managed-config").status).toBe("FAIL");
  });
  it("validates an optional header when it is actually present", () => {
    const input = fixture(); input.contract.optionalHints!.formFactors = false;
    input.actual.requestHeaders.window.uaFormFactors = '"Mobile"';
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("FAIL");
    expect(assertion(result, "request.window.uaFormFactors.value").status).toBe("FAIL");
  });
  it("extends the old corpus structurally, but never upgrades old partial evidence into full PASS", () => {
    const full = fixture().actual;
    const legacy: HostIdentityCorpus = { window: full.window, worker: full.worker, requestHeaders: full.requestHeaders };
    const compatible: FullHostIdentityCorpus = legacy;
    const input = fixture(); input.actual = compatible;
    expect(validateFullHostIdentity(input).status).toBe("FAIL");
  });
  it("rejects stale actual runtime even when configured UA, every JS context, HTTP and CDP UA agree with each other", () => {
    const input = fixture();
    input.runtime.executableFullVersion = "153.0.8000.1"; input.runtime.product = "Chrome/153.0.8000.1"; input.runtime.versionElement = "153.0.8000.1";
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("FAIL");
    expect(assertion(result, "navigator.shared.cross-surface").status).toBe("PASS");
    expect(assertion(result, "coherence.legacy-core").status).toBe("PASS");
    expect(assertion(result, "managed-config.runtime-version").status).toBe("FAIL");
    expect(assertion(result, "navigator.window.brand-versions").status).toBe("FAIL");
  });
  it("keeps coherence separate from managed-config fulfillment for consistently wrong architecture and platformVersion", () => {
    const input = fixture();
    for (const nav of allNavigators(input)) { nav.highEntropy!.architecture = "arm"; nav.highEntropy!.platformVersion = "26.3.0"; }
    syncHeaders(input);
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("FAIL");
    expect(assertion(result, "navigator.service.cross-surface").status).toBe("PASS");
    expect(assertion(result, "coherence.legacy-core").status).toBe("PASS");
    expect(assertion(result, "navigator.window.managed-config").status).toBe("FAIL");
  });
  it.each(["Chrome/1152.0.7977.720", "Chrome/152.0.7977.72 extra", "Chrome/152.0.7977.72\n"])("rejects product substring/canonical trap %j", (product) => {
    const input = fixture(); input.runtime.product = product;
    expect(validateFullHostIdentity(input).status).toBe("FAIL");
  });
  it.each(["152.0.7977.720", "1152.0.7977.72", "release 152.0.7977.72", "152.0.7977", "152.00.7977.72", "152.0.7977.72\n"])
    ("rejects exact version-element trap %j", (version) => {
      const input = fixture(); input.runtime.versionElement = version;
      expect(validateFullHostIdentity(input).status).toBe("FAIL");
    });
  it("rejects body fallback even if it happens to equal the exact configured version", () => {
    const input = fixture(); Object.assign(input.runtime, { versionElementSource: "document.body" });
    expect(assertion(validateFullHostIdentity(input), "runtime.version-source").status).toBe("FAIL");
  });
  it.each(["runId", "profileId", "pid", "mode", "executableSha256"] as const)("rejects %s drift from independently verified process binding", (field) => {
    const input = fixture();
    Object.assign(input.actual.binding!, { [field]: field === "pid" ? 44 : field === "mode" ? "headless" : field === "executableSha256" ? "b".repeat(64) : "wrong-binding" });
    expect(assertion(validateFullHostIdentity(input), "runtime.binding").status).toBe("FAIL");
  });
  it("never promotes the CDP userAgent to the runtime version oracle", () => {
    const input = fixture(); input.runtime.userAgent = input.runtime.userAgent.replace(VERSION, "153.0.8000.1");
    const result = validateFullHostIdentity(input);
    expect(result.runtimeVersion).toBe(VERSION);
    expect(assertion(result, "runtime.cdp-user-agent.runtime").status).toBe("FAIL");
  });
  it.each(["Chrome", "Chromium", "HeadlessChrome", "HeadlessChromium"] as const)("accepts native reduction and legitimate %s labels without requiring Google Chrome branding", (product) => {
    const input = fixture("off"); changeBinding(input, "mode", "headless");
    input.runtime.product = `${product}/${VERSION}`;
    for (const nav of allNavigators(input)) nav.userAgent = nav.userAgent.replace("Chrome/", `${product}/`);
    input.runtime.userAgent = input.actual.window.userAgent; syncHeaders(input);
    expectPass(input);
  });
  it("accepts native full UA and rejects native wrong-major reduction and managed reduced UA", () => {
    const native = fixture("off");
    for (const nav of allNavigators(native)) nav.userAgent = nav.userAgent.replace("152.0.0.0", VERSION);
    native.runtime.userAgent = native.actual.window.userAgent; syncHeaders(native); expectPass(native);
    for (const nav of allNavigators(native)) nav.userAgent = nav.userAgent.replace(VERSION, "151.0.0.0");
    native.runtime.userAgent = native.actual.window.userAgent; syncHeaders(native);
    expect(validateFullHostIdentity(native).status).toBe("FAIL");
    const managed = fixture();
    for (const nav of allNavigators(managed)) nav.userAgent = nav.userAgent.replace(VERSION, "152.0.0.0");
    managed.runtime.userAgent = managed.actual.window.userAgent; managed.contract.expectedManaged!.userAgent = managed.actual.window.userAgent; syncHeaders(managed);
    expect(validateFullHostIdentity(managed).status).toBe("FAIL");
  });
  it("rejects a headless runtime product on a headed binding", () => {
    const input = fixture("off"); input.runtime.product = `HeadlessChrome/${VERSION}`;
    expect(assertion(validateFullHostIdentity(input), "runtime.product-mode").status).toBe("FAIL");
  });
  it("compares real brands semantically, tolerating GREASE and ordering differences in every context and header", () => {
    const input = fixture();
    IDENTITY_CONTEXTS.forEach((context, index) => {
      const nav = navigator(input, context);
      nav.brands = [{ brand: index % 2 ? "Not;A=Brand" : "Not(A:Brand", version: index % 2 ? "24" : "8" }, ...nav.brands!.filter((item) => item.brand !== "Not_A Brand").reverse()];
      nav.highEntropy!.fullVersionList = [{ brand: "Not/A)Brand", version: "99.0.0.0" }, ...nav.highEntropy!.fullVersionList!.filter((item) => item.brand !== "Not_A Brand").reverse()];
    });
    syncHeaders(input); expectPass(input);
  });
  it.each(["missing", "duplicate", "conflicting", "wrong-major", "wrong-full", "unknown-not-grease"] as const)("rejects %s real brands", (failure) => {
    const input = fixture(), nav = navigator(input, "shared");
    if (failure === "missing") { nav.brands = nav.brands!.filter((item) => item.brand !== "Chromium"); nav.highEntropy!.fullVersionList = nav.highEntropy!.fullVersionList!.filter((item) => item.brand !== "Chromium"); }
    if (failure === "duplicate") nav.brands!.push({ brand: "Chromium", version: "152" });
    if (failure === "conflicting") nav.highEntropy!.fullVersionList!.push({ brand: "Chromium", version: "153.0.8000.1" });
    if (failure === "wrong-major") nav.brands![0].version = "151";
    if (failure === "wrong-full") nav.highEntropy!.fullVersionList![0].version = "152.0.7977.71";
    if (failure === "unknown-not-grease") { nav.brands!.push({ brand: "Unknown Browser", version: "99" }); nav.highEntropy!.fullVersionList!.push({ brand: "Unknown Browser", version: "99.0.0.0" }); }
    syncHeaders(input); expect(validateFullHostIdentity(input).status).toBe("FAIL");
  });
  it("requires the configured Google Chrome brand only for the managed contract, not for native Chromium", () => {
    const input = fixture();
    for (const nav of allNavigators(input)) {
      nav.brands = nav.brands!.filter((item) => item.brand !== "Google Chrome");
      nav.highEntropy!.brands = nav.highEntropy!.brands!.filter((item) => item.brand !== "Google Chrome");
      nav.highEntropy!.fullVersionList = nav.highEntropy!.fullVersionList!.filter((item) => item.brand !== "Google Chrome");
    }
    syncHeaders(input);
    const result = validateFullHostIdentity(input);
    expect(assertion(result, "navigator.window.brand-versions").status).toBe("PASS");
    expect(assertion(result, "navigator.window.managed-config").status).toBe("FAIL");
    expectPass(fixture("off"));
  });
  it.each(["model", "wow64", "fullVersionList"] as const)("distinguishes present-empty/false from missing %s", (field) => {
    const input = fixture(); expectPass(input);
    delete navigator(input, "service").highEntropy![field];
    expect(validateFullHostIdentity(input).status).toBe("FAIL");
  });
  it.each(["uaFullVersion", "formFactors"] as const)("requires declared optional %s, and does not invent support when it is undeclared", (field) => {
    const input = fixture();
    delete navigator(input, "cross-origin-frame").highEntropy![field];
    expect(validateFullHostIdentity(input).status).toBe("FAIL");
    const undeclared = fixture(); undeclared.contract.optionalHints![field] = false;
    for (const nav of allNavigators(undeclared)) delete nav.highEntropy![field];
    for (const context of IDENTITY_CONTEXTS) undeclared.actual.requestHeaders[context]![field === "formFactors" ? "uaFormFactors" : field] = null;
    expectPass(undeclared);
  });
  it.each(IDENTITY_CONTEXTS)("rejects missing %s navigator, request evidence, or actual header capture", (context) => {
    const navMissing = fixture(); delete navMissing.actual.navigators![context];
    expect(validateFullHostIdentity(navMissing).status).toBe("FAIL");
    const evidenceMissing = fixture(); delete evidenceMissing.actual.requestEvidence![context];
    expect(validateFullHostIdentity(evidenceMissing).status).toBe("FAIL");
    const headersMissing = fixture(); delete (headersMissing.actual.requestHeaders as Partial<Record<IdentityContext, FullHostIdentityRequestHeaders>>)[context];
    expect(validateFullHostIdentity(headersMissing).status).toBe("FAIL");
  });
  it("rejects stale full-identity fields in the old window/worker aliases", () => {
    const input = fixture(); input.actual.worker = structuredClone(input.actual.worker); input.actual.worker.highEntropy!.wow64 = true;
    expect(assertion(validateFullHostIdentity(input), "navigator.worker.legacy-alias").status).toBe("FAIL");
  });
  it("rejects malformed wire booleans, quoted strings and brand lists", () => {
    for (const [field, value] of [["uaWow64", "false"], ["uaMobile", '"?0"'], ["uaModel", '"bad\\u0041"'],
      ["uaBrands", '"Chromium";v="152",'], ["uaFormFactors", '["Desktop"]']] as const) {
      const input = fixture(); input.actual.requestHeaders.shared[field] = value;
      expect(validateFullHostIdentity(input).status, `${field} ${value}`).toBe("FAIL");
    }
  });
  it("uses only explicit frame prerequisites for BLOCKED, never infers unsupported from failure", () => {
    const input = fixture();
    input.actual.requestEvidence!["cross-origin-frame"]!.negotiation!.permissionsPolicyDelegated = false;
    input.actual.navigators!["cross-origin-frame"] = { status: "blocked", reason: "fixture policy not delegated" };
    input.actual.requestEvidence!["cross-origin-frame"]!.status = "blocked";
    delete input.actual.requestHeaders["cross-origin-frame"];
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("BLOCKED");
    expect(result.assertions.some((item) => item.status === "UNSUPPORTED" || item.status === "FAIL")).toBe(false);
    expect(assertion(result, "request.cross-origin-frame.prerequisites").required).toBe(true);
  });
  it("keeps a captured but nondelegated frame BLOCKED rather than claiming missing hints are an identity defect", () => {
    const input = fixture(), context = "cross-origin-frame";
    input.actual.requestEvidence![context]!.negotiation!.permissionsPolicyDelegated = false;
    navigator(input, context).highEntropy = null;
    for (const field of HINT_HEADERS) input.actual.requestHeaders[context]![field] = null;
    expect(validateFullHostIdentity(input).status).toBe("BLOCKED");
  });
  it.each(["uaBrands", "uaMobile", "uaModel", "uaWow64", "uaFullVersionList", "uaFullVersion", "uaFormFactors"] as const)("rejects new partial absence of negotiated %s even with a native control", (field) => {
    const input = fixture(), native = fixture("off"); input.nativeControl = { actual: native.actual, runtime: native.runtime };
    input.actual.requestHeaders.shared[field] = null;
    expect(assertion(validateFullHostIdentity(input), "request.shared.hint-shape").status).toBe("FAIL");
  });
  it("does not treat missing opt-in or an invalid request origin as supported native omission", () => {
    const input = omissionFixture(); input.actual.requestEvidence!.shared!.negotiation!.postOptInRequest = false;
    expect(validateFullHostIdentity(input).status).toBe("FAIL");
    const origin = fixture(); origin.actual.requestEvidence!.window!.requestUrl = "https://unnegotiated.identity.test/echo";
    expect(assertion(validateFullHostIdentity(origin), "request.window.origin-binding").status).toBe("FAIL");
  });
  it("returns named failures for timeouts, invalid capture shapes, and invalid top-level inputs", () => {
    for (const status of ["timeout", "error", "unknown"] as const) {
      const input = fixture(); Object.assign(input.actual.navigators!.shared!, { status, identity: undefined, reason: "synthetic capture failure" });
      expect(assertion(validateFullHostIdentity(input), "navigator.shared.capture").status).toBe("FAIL");
    }
    const request = fixture(); request.actual.requestEvidence!.service!.status = "timeout";
    expect(assertion(validateFullHostIdentity(request), "request.service.capture").status).toBe("FAIL");
    const shape = fixture(); shape.actual.navigators!.service!.identity = {} as FullHostNavigatorIdentity;
    expect(assertion(validateFullHostIdentity(shape), "navigator.service.shape").status).toBe("FAIL");
    for (const input of [null, {}, { actual: {}, runtime: null, contract: {} }]) {
      expect(validateFullHostIdentity(input as unknown as FullHostIdentityInput).status).toBe("FAIL");
    }
    expect(() => verifyFullHostIdentity(shape)).toThrow(/navigator.service.shape/);
  });
  it("retains explicit NOTRUN in the required denominator", () => {
    const input = fixture(); input.actual.navigators!.shared = { status: "notrun", reason: "not collected" };
    const result = validateFullHostIdentity(input);
    expect(result.status).not.toBe("PASS");
    expect(assertion(result, "navigator.shared.capture")).toMatchObject({ status: "NOTRUN", required: true });
  });
});

function nativeCpuFixture(architecture: "arm" | "x86" = "arm"): FullHostIdentityInput {
  const input = fixture(), native = fixture("off");
  input.contract.managedCpuPolicy = "native-control";
  Object.assign(input.contract.expectedManaged!, { architecture, bitness: "64" });
  for (const sample of [input, native]) {
    for (const nav of allNavigators(sample)) nav.highEntropy!.architecture = architecture;
    syncHeaders(sample);
  }
  input.nativeControl = { actual: native.actual, runtime: native.runtime };
  return input;
}

describe("explicit macOS native-controlled CPU identity", () => {
  it.each(["arm", "x86"] as const)("accepts independently bound native %s CPU metadata without changing the legacy MacIntel platform", (architecture) => {
    const input = nativeCpuFixture(architecture), result = expectPass(input);
    expect(input.actual.window.platform).toBe("MacIntel");
    for (const context of IDENTITY_CONTEXTS) {
      expect(assertion(result, `navigator.${context}.native-cpu`)).toMatchObject({ status: "PASS", required: true });
      for (const header of ["uaArchitecture", "uaBitness"]) expect(assertion(result, `request.${context}.${header}.native-cpu`).status).toBe("PASS");
    }
  });
  it("rejects coherent configured x86 on a strictly bound native ARM control", () => {
    const input = nativeCpuFixture();
    input.contract.expectedManaged!.architecture = "x86";
    for (const nav of allNavigators(input)) nav.highEntropy!.architecture = "x86";
    syncHeaders(input);
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("FAIL");
    expect(assertion(result, "navigator.window.managed-config").status).toBe("PASS");
    expect(assertion(result, "navigator.service.cross-surface").status).toBe("PASS");
    expect(assertion(result, "native-cpu.control").status).toBe("PASS");
    for (const context of IDENTITY_CONTEXTS) expect(assertion(result, `navigator.${context}.native-cpu`).status).toBe("FAIL");
    expect(assertion(result, "request.window.uaArchitecture.native-cpu").status).toBe("FAIL");
  });
  it.each(["architecture", "bitness"] as const)("requires explicit managed %s rather than silently reusing the persona default", (field) => {
    const input = nativeCpuFixture("x86"); delete input.contract.expectedManaged![field];
    const result = validateFullHostIdentity(input);
    expect(result.status).toBe("FAIL");
    expect(assertion(result, "managed-native-cpu.expected").status).toBe("FAIL");
  });
  it("requires an independently verified native control even when every request sends all negotiated hints", () => {
    const input = nativeCpuFixture(); delete input.nativeControl;
    expect(assertion(validateFullHostIdentity(input), "native-cpu.control").status).toBe("FAIL");
  });
  it.each(["missing-actual", "wrong-runtime", "wrong-host", "wrong-run", "wrong-executable", "wrong-window-mode", "unverified-binding", "same-pid", "same-profile"] as const)("rejects %s native CPU authority", (failure) => {
    const input = nativeCpuFixture(), native = { ...fixture("off"), ...input.nativeControl! };
    if (failure === "missing-actual") input.nativeControl = {} as NonNullable<FullHostIdentityInput["nativeControl"]>;
    if (failure === "wrong-runtime") native.runtime.product = "Chrome/153.0.8000.1";
    if (failure === "wrong-host") changeBinding(native, "hostId", "other-native-host");
    if (failure === "wrong-run") changeBinding(native, "runId", "other-native-run");
    if (failure === "wrong-executable") changeBinding(native, "executableSha256", "b".repeat(64));
    if (failure === "wrong-window-mode") changeBinding(native, "mode", "headless");
    if (failure === "unverified-binding") native.runtime.verifiedBinding.pid++;
    if (failure === "same-pid" || failure === "same-profile") {
      const field = failure === "same-pid" ? "pid" : "profileId";
      for (const binding of [native.actual.binding!, native.runtime.binding, native.runtime.verifiedBinding]) Object.assign(binding, { [field]: input.runtime.binding[field] });
    }
    expect(assertion(validateFullHostIdentity(input), "native-cpu.control").status).toBe("FAIL");
  });
  it("rejects mutually coherent but invalid native CPU values", () => {
    for (const [architecture, bitness] of [["not-a-cpu", "64"], ["arm", "32"]]) {
      const input = nativeCpuFixture(), native = { ...fixture("off"), ...input.nativeControl! };
      Object.assign(input.contract.expectedManaged!, { architecture, bitness });
      for (const sample of [input, native]) {
        for (const nav of allNavigators(sample)) Object.assign(nav.highEntropy!, { architecture, bitness });
        syncHeaders(sample);
      }
      expect(assertion(validateFullHostIdentity(input), "native-cpu.control").status).toBe("FAIL");
    }
  });
  it("does not promote matching native worker omissions into verified CPU header values", () => {
    const input = nativeCpuFixture();
    for (const context of ["dedicated", "shared", "service"] as const) {
      for (const corpus of [input.actual, input.nativeControl!.actual]) for (const key of HINT_HEADERS) corpus.requestHeaders[context][key] = null;
    }
    const result = expectPass(input);
    for (const context of ["dedicated", "shared", "service"]) {
      expect(assertion(result, `navigator.${context}.native-cpu`).status).toBe("PASS");
      for (const header of ["uaArchitecture", "uaBitness"]) expect(assertion(result, `request.${context}.${header}.native-cpu`)).toMatchObject({ status: "NOTRUN", required: false });
    }
  });
  it.each(["off", "unsupported-host", "unknown-policy"] as const)("rejects a %s CPU policy instead of silently weakening it", (failure) => {
    const input = nativeCpuFixture();
    if (failure === "off") input.contract.mode = "off";
    if (failure === "unsupported-host") input.contract.hostPlatform = "win32";
    if (failure === "unknown-policy") Object.assign(input.contract, { managedCpuPolicy: "guess-from-managed" });
    expect(assertion(validateFullHostIdentity(input), "contract.managed-cpu-policy").status).toBe("FAIL");
  });
});

describe("strict native-controlled worker HTTP omission shape", () => {
  it("passes only the request-conformance shape, never verifies nonexistent hint values", () => {
    const result = expectPass(omissionFixture());
    expect(result.nativeControl!.status).toBe("PASS");
    for (const context of ["dedicated", "shared", "service"] as const) {
      expect(assertion(result, `request.${context}.omission-shape`)).toMatchObject({ status: "PASS", required: true, kind: "omission" });
      for (const field of HINT_HEADERS) {
        expect(assertion(result, `request.${context}.${field}`)).toMatchObject({ status: "NOTRUN", required: false });
        expect(assertion(result, `request.${context}.${field}`).conditionalNotApplicableReason).toBeTruthy();
      }
    }
  });
  it("allows intentionally different native profile/PID/identity mode and native hardware metadata", () => {
    const input = omissionFixture();
    expect(input.nativeControl!.runtime.binding.profileId).not.toBe(input.runtime.binding.profileId);
    expect(input.nativeControl!.runtime.binding.pid).not.toBe(input.runtime.binding.pid);
    expect(input.nativeControl!.actual.window.highEntropy!.architecture).toBe("arm");
    expectPass(input);
  });
  it.each(["runId", "hostId", "executableSha256", "mode"] as const)("rejects valid off controls with a different %s", (key) => {
    const input = omissionFixture();
    const native = { ...fixture("off"), ...input.nativeControl! };
    changeBinding(native, key, key === "mode" ? "headless" : key === "executableSha256" ? "b".repeat(64) : "different");
    const result = validateFullHostIdentity(input);
    expect(result.nativeControl!.status).toBe("PASS");
    expect(assertion(result, "native-control.binding").status).toBe("FAIL");
    expect(result.status).toBe("FAIL");
  });
  it("requires an independently verified native/off binding and validates native identity before using its omissions", () => {
    const input = omissionFixture();
    input.nativeControl!.runtime.verifiedBinding.pid++;
    expect(assertion(validateFullHostIdentity(input), "native-control.identity").status).toBe("FAIL");
    const copiedManaged = omissionFixture();
    copiedManaged.nativeControl = { actual: structuredClone(copiedManaged.actual), runtime: structuredClone(copiedManaged.runtime) };
    expect(assertion(validateFullHostIdentity(copiedManaged), "native-control.identity").status).toBe("FAIL");
    const wrongRuntime = omissionFixture(); wrongRuntime.nativeControl!.runtime.product = "Chrome/153.0.8000.1";
    expect(assertion(validateFullHostIdentity(wrongRuntime), "native-control.identity").status).toBe("FAIL");
  });
  it("requires equivalent origin negotiation rather than merely an off-mode label", () => {
    const input = omissionFixture(), negotiation = input.nativeControl!.actual.requestEvidence!.shared!.negotiation!;
    negotiation.acceptCH = [...negotiation.acceptCH, "sec-ch-dpr"];
    const result = validateFullHostIdentity(input);
    expect(result.nativeControl!.status).toBe("PASS");
    expect(assertion(result, "request.shared.omission-shape").status).toBe("FAIL");
    expect(result.status).toBe("FAIL");
  });
  it("accepts equivalent negotiation despite object insertion order and hint order", () => {
    const input = omissionFixture();
    for (const context of IDENTITY_CONTEXTS) {
      const n = input.nativeControl!.actual.requestEvidence![context]!.negotiation!;
      input.nativeControl!.actual.requestEvidence![context]!.negotiation = { delegatedHints: [...n.delegatedHints].reverse(), acceptCH: [...n.acceptCH].reverse(),
        permissionsPolicyDelegated: n.permissionsPolicyDelegated, postOptInRequest: n.postOptInRequest, optInResponseReceived: n.optInResponseReceived,
        secureContext: n.secureContext, topLevelOrigin: n.topLevelOrigin, origin: n.origin };
    }
    expectPass(input);
  });
  it("rejects absent controls, undeclared exception, partial omission, new missing fields and malformed controls", () => {
    const noControl = omissionFixture(); delete noControl.nativeControl;
    expect(validateFullHostIdentity(noControl).status).toBe("FAIL");
    const policy = omissionFixture(); policy.contract.workerHintPolicy = "required";
    expect(validateFullHostIdentity(policy).status).toBe("FAIL");
    const partial = omissionFixture(); partial.actual.requestHeaders.shared.uaModel = '""';
    expect(assertion(validateFullHostIdentity(partial), "request.shared.hint-shape").status).toBe("FAIL");
    const nativeSent = omissionFixture(); nativeSent.nativeControl!.actual.requestHeaders.shared = fixture("off").actual.requestHeaders.shared;
    expect(assertion(validateFullHostIdentity(nativeSent), "request.shared.omission-shape").status).toBe("FAIL");
    const malformed = omissionFixture(); malformed.nativeControl!.actual.requestHeaders.window.uaWow64 = "false";
    expect(assertion(validateFullHostIdentity(malformed), "native-control.identity").status).toBe("FAIL");
    const nativePartial = omissionFixture(); nativePartial.nativeControl!.actual.requestHeaders.service.uaBitness = '"64"';
    expect(assertion(validateFullHostIdentity(nativePartial), "native-control.identity").status).toBe("FAIL");
  });
  it("rejects malformed native-control input as a named failure rather than throwing", () => {
    const input = omissionFixture(); input.nativeControl = {} as NonNullable<FullHostIdentityInput["nativeControl"]>;
    expect(assertion(validateFullHostIdentity(input), "native-control.identity").status).toBe("FAIL");
  });
  it("does not pass omission shape for unsuccessful requests or incorrect UA", () => {
    const failed = omissionFixture(); failed.actual.requestEvidence!.shared!.responseStatus = 500;
    expect(assertion(validateFullHostIdentity(failed), "request.shared.omission-shape").status).toBe("FAIL");
    const ua = omissionFixture(); ua.actual.requestHeaders.shared.userAgent = ua.nativeControl!.actual.window.userAgent;
    expect(assertion(validateFullHostIdentity(ua), "request.shared.omission-shape").status).toBe("FAIL");
  });
  it("never applies the worker omission exception to window or frames", () => {
    for (const context of ["window", "same-origin-frame", "cross-origin-frame"] as const) {
      const input = omissionFixture(); for (const field of HINT_HEADERS) input.actual.requestHeaders[context]![field] = null;
      expect(validateFullHostIdentity(input).status).toBe("FAIL");
    }
  });
});
