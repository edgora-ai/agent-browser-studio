import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const VERIFIER = path.join(ROOT, "src", "tools", "verify-native-chromium.ts");
const FINGERPRINT_BASELINE = path.join(ROOT, "src", "main", "services", "fingerprint-baseline.ts");
const E2E_HELPER = path.join(ROOT, "tests", "e2e", "helpers", "app.ts");
const GATE = path.join(ROOT, "patches", "chromium", "scripts", "gate152.mjs");
const CAPTURE = path.join(ROOT, "patches", "chromium", "scripts", "capture-stock152.mjs");
const PING0 = path.join(ROOT, "src", "tools", "verify-ping0.ts");
const STOCK_CORPUS = path.join(
  ROOT,
  "patches",
  "chromium",
  "corpora-152",
  "stock-chrome-152.0.7977.64.json",
);

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const WEBGL_REALMS = ["window", "windowOffscreen", "worker"] as const;
const EXPECTED_WEBGL = {
  vendor: "Google Inc. (Apple)",
  renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
};

interface GpuContracts {
  webGlCorpusSha256(contexts: unknown): string;
  webGpuCorpusSha256(context: unknown): string;
  verifyNativeGpuCorpus(actual: unknown, native: unknown, label?: string, expectedWebgl?: { vendor: string; renderer: string }): void;
  configuredWebGlIdentity(config: { webgl: { vendor: string; renderer: string } } | null): { vendor: string; renderer: string } | undefined;
  projectNativeWebGlCorpus(native: unknown, expectedWebgl?: { vendor: string; renderer: string }): unknown;
  webGlProbeHash(corpus: unknown): string;
}
function gpuContracts(): GpuContracts {
  const source = fs.readFileSync(VERIFIER, "utf8");
  const file = ts.createSourceFile(VERIFIER, source, ts.ScriptTarget.Latest, true);
  const functions = ["fail", "expect", "expectEqual", "webGlCorpusSha256", "webGpuCorpusSha256", "configuredWebGlIdentity", "projectNativeWebGlCorpus", "webGlProbeHash", "verifyNativeGpuCorpus"].map(name => {
    const matches = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    expect(matches, `unique pure GPU helper ${name}`).toHaveLength(1);
    return matches[0].getText(file);
  });
  // Evaluate only the real pure helpers. Never import main, Playwright, a native
  // browser, runtime config, or capture/startup code to test these contracts.
  const compiled = ts.transpileModule(functions.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { createHash, exports: {} as GpuContracts };
  vm.runInNewContext(`${compiled}\nObject.assign(exports, { configuredWebGlIdentity, projectNativeWebGlCorpus, webGlProbeHash });`, context, { timeout: 1000 });
  return context.exports;
}
function nativeFixture() {
  // Historical stock data is inert test input, NOT a release/physical-GPU oracle.
  // Its missing Window Offscreen arm is explicitly synthesized here only; real
  // captures must supply that arm themselves and missing-arm tests fail closed.
  const corpus = JSON.parse(fs.readFileSync(STOCK_CORPUS, "utf8"));
  return { webgl: { ...corpus.webgl, windowOffscreen: structuredClone(corpus.webgl.window) }, webgpu: corpus.webgpu };
}

function managedFixture(native = nativeFixture(), expectedWebgl = EXPECTED_WEBGL) {
  const actual = structuredClone(native);
  for (const realm of WEBGL_REALMS) for (const kind of ["webgl1", "webgl2"] as const) {
    actual.webgl[realm][kind].unmaskedVendor = expectedWebgl.vendor;
    actual.webgl[realm][kind].unmaskedRenderer = expectedWebgl.renderer;
  }
  return actual;
}

describe("Chromium 152 verification guards", () => {
  it("pins the verifier to fail-closed Chromium 152 capability references", () => {
    const verifier = fs.readFileSync(VERIFIER, "utf8");
    expect(verifier).toContain('const TARGET_CHROMIUM_VERSION = "152.0.7977.72"');
    expect(verifier).toContain("Unable to execute Chromium --version");
    expect(verifier).toContain("Unable to parse Chromium version");
    expect(verifier).not.toContain('|| "149.0.7827.22"');
    expect(verifier).not.toContain('return "149.0.7827.22"');
    expect(verifier).toContain("export function verifyNativeGpuCorpus(");
    expect(verifier).not.toContain("STOCK_CHROME_152_WEBGL_CAPABILITY_SHA256");
    expect(verifier).not.toContain("STOCK_CHROME_152_WEBGPU_CAPABILITY_SHA256");
    expect(verifier).not.toContain("stockChrome150Sha256");
    expect(verifier).not.toContain("--enable-unsafe-webgpu");
    expect(verifier).not.toContain("--ignore-gpu-blocklist");
    const baseline = fs.readFileSync(FINGERPRINT_BASELINE, "utf8");
    expect(baseline).toContain('await import("./page-eval.js")');
    expect(baseline).not.toContain('import { evaluateInPage } from "./page-eval.js"');
    const ping0 = fs.readFileSync(PING0, "utf8");
    expect(ping0).toContain("attempt <= 3");
    expect(ping0).toMatch(/"https:\/\/ipwho\.is\/",\r?\n\s+15/);
    expect(ping0).toContain("Unable to execute Chromium --version");
    expect(ping0).toContain("Unable to parse Chromium version");
    expect(ping0).not.toContain('return "150.0.7871.114"');
  });

  it("hashes full identities and accepts a healthy native Window/Offscreen/Worker fixture", () => {
    const contracts = gpuContracts(), native = nativeFixture();
    for (const realm of WEBGL_REALMS) {
      expect(native.webgl[realm].webgl1).toBeTruthy();
      expect(native.webgl[realm].webgl2).toBeTruthy();
      expect(contracts.webGlCorpusSha256(native.webgl[realm])).toBe(sha(native.webgl[realm]));
    }
    expect(native.webgpu.window.available).toBe(true);
    expect(native.webgpu.window.device).toBeTruthy();
    for (const realm of ["window", "worker"] as const) {
      expect(contracts.webGpuCorpusSha256(native.webgpu[realm])).toBe(sha(native.webgpu[realm]));
      expect(native.webgpu[realm].device.adapterInfo).toEqual(native.webgpu[realm].adapter.info);
    }
    expect(() => contracts.verifyNativeGpuCorpus(structuredClone(native), native, "managed fixture")).not.toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(structuredClone(native), native, "pass-through fixture")).not.toThrow();
  });

  it.each([
    EXPECTED_WEBGL,
    { vendor: "generated vendor fixture", renderer: "generated renderer fixture" },
  ])("accepts only the supplied simulated identity projection without mutating either corpus (%#)", expectedWebgl => {
    const contracts = gpuContracts(), native = nativeFixture();
    // Preserve fields unknown to the verifier too; a whitelist reconstruction
    // of just the familiar capabilities would silently drop this native data.
    for (const realm of WEBGL_REALMS) for (const kind of ["webgl1", "webgl2"] as const) {
      native.webgl[realm][kind].extraNativeCapability = { vendor: "must remain native", values: [1, 2, 3] };
    }
    const actual = managedFixture(native, expectedWebgl);
    const before = JSON.stringify({ native, actual });
    expect(actual.webgl.window.webgl1.unmaskedRenderer).not.toBe(native.webgl.window.webgl1.unmaskedRenderer);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "simulated identity conformance", expectedWebgl)).not.toThrow();
    expect(JSON.stringify({ native, actual })).toBe(before);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native)).toThrow();
  });

  it("never learns the expected identity from actual or rewrites an aliased native baseline", () => {
    const contracts = gpuContracts(), native = nativeFixture(), before = JSON.stringify(native);
    expect(() => contracts.verifyNativeGpuCorpus(native, native, "explicit generated expectation", EXPECTED_WEBGL)).toThrow();
    expect(JSON.stringify(native)).toBe(before);
    const actual = managedFixture(native);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "wrong generated expectation", {
      ...EXPECTED_WEBGL, renderer: `${EXPECTED_WEBGL.renderer} wrong`,
    })).toThrow();
    expect(JSON.stringify(native)).toBe(before);
  });

  it.each([
    null, {}, { vendor: "", renderer: "" },
    { vendor: " ", renderer: EXPECTED_WEBGL.renderer },
    { vendor: EXPECTED_WEBGL.vendor, renderer: "" },
    { vendor: EXPECTED_WEBGL.vendor }, { renderer: EXPECTED_WEBGL.renderer },
    { vendor: null, renderer: EXPECTED_WEBGL.renderer },
    { vendor: EXPECTED_WEBGL.vendor, renderer: 3 },
  ])("rejects an explicitly incomplete expected pair instead of falling back to native (%#)", expectedWebgl => {
    const contracts = gpuContracts(), native = nativeFixture();
    expect(() => contracts.verifyNativeGpuCorpus(native, native, "malformed expectation", expectedWebgl as any)).toThrow();
  });

  it.each(WEBGL_REALMS)("rejects generated identity injection that omits the %s arm", realm => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = managedFixture(native);
    actual.webgl[realm] = structuredClone(native.webgl[realm]);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "partial injection", EXPECTED_WEBGL)).toThrow();
  });

  it.each(["unmaskedVendor", "unmaskedRenderer"])("requires exact generated %s, not merely coherent realm values", field => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = managedFixture(native);
    for (const realm of WEBGL_REALMS) for (const kind of ["webgl1", "webgl2"] as const) {
      actual.webgl[realm][kind][field] += " wrong";
    }
    expect(actual.webgl.window).toEqual(actual.webgl.worker);
    expect(actual.webgl.window).toEqual(actual.webgl.windowOffscreen);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "coherent but wrong identity", EXPECTED_WEBGL)).toThrow();
  });

  it.each([
    "version", "vendor", "renderer", "contextAttributes", "extensions", "parameters", "shaderPrecision",
  ])("retains the entire native WebGL %s surface under a generated identity", field => {
    const contracts = gpuContracts(), native = nativeFixture();
    for (const mutation of ["change", "delete"] as const) {
      const actual = managedFixture(native);
      for (const realm of WEBGL_REALMS) for (const kind of ["webgl1", "webgl2"] as const) {
        const context = actual.webgl[realm][kind];
        if (mutation === "delete") delete context[field];
        else if (field === "parameters") context.parameters.MAX_TEXTURE_SIZE += 1;
        else if (field === "extensions") context.extensions.push("synthetic-extension");
        else if (field === "shaderPrecision") context.shaderPrecision.VERTEX_HIGH_FLOAT.precision += 1;
        else if (field === "contextAttributes") context.contextAttributes.antialias = !context.contextAttributes.antialias;
        else if (field === "version") context.version = 0;
        else context[field] += " synthetic-mismatch";
      }
      expect(actual.webgl.window).toEqual(actual.webgl.worker);
      expect(actual.webgl.window).toEqual(actual.webgl.windowOffscreen);
      expect(() => contracts.verifyNativeGpuCorpus(actual, native, `${mutation} ${field}`, EXPECTED_WEBGL)).toThrow();
    }
  });

  it.each(["actual", "native", "both"])("requires Window Offscreen evidence in %s, including strict native mode", missingFrom => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = structuredClone(native);
    if (missingFrom !== "native") delete actual.webgl.windowOffscreen;
    if (missingFrom !== "actual") delete native.webgl.windowOffscreen;
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "missing Offscreen evidence")).toThrow(/windowOffscreen.*unavailable/);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "missing managed Offscreen evidence", EXPECTED_WEBGL)).toThrow(/windowOffscreen.*unavailable/);
  });

  it.each(["webgl1", "webgl2"] as const)("rejects matching incomplete Window Offscreen %s", kind => {
    const contracts = gpuContracts(), actual = nativeFixture();
    actual.webgl.windowOffscreen[kind] = null;
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual))).toThrow(/windowOffscreen.*unavailable/);
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual), "managed fixture", EXPECTED_WEBGL)).toThrow(/windowOffscreen.*unavailable/);
  });

  it.each(["unmaskedVendor", "unmaskedRenderer"])("rejects matching missing %s in every WebGL arm", field => {
    const contracts = gpuContracts();
    for (const realm of WEBGL_REALMS) for (const kind of ["webgl1", "webgl2"] as const) {
      const incomplete = nativeFixture();
      delete incomplete.webgl[realm][kind][field];
      expect(() => contracts.verifyNativeGpuCorpus(incomplete, structuredClone(incomplete))).toThrow(/unmasked.*unavailable/);
      expect(() => contracts.verifyNativeGpuCorpus(incomplete, structuredClone(incomplete), "managed fixture", EXPECTED_WEBGL)).toThrow(/unmasked.*unavailable/);
    }
  });

  it("keeps legacy empty config native and forwards nonempty or one-sided pairs without learning actual values", () => {
    const contracts = gpuContracts(), native = nativeFixture();
    expect(contracts.configuredWebGlIdentity(null)).toBeUndefined();
    expect(contracts.configuredWebGlIdentity({ webgl: { vendor: "", renderer: "" } })).toBeUndefined();
    const configured = { webgl: { ...EXPECTED_WEBGL } };
    expect(contracts.configuredWebGlIdentity(configured)).toBe(configured.webgl);
    for (const webgl of [{ vendor: "", renderer: EXPECTED_WEBGL.renderer }, { vendor: EXPECTED_WEBGL.vendor, renderer: "" }]) {
      expect(contracts.configuredWebGlIdentity({ webgl })).toBe(webgl);
      expect(() => contracts.verifyNativeGpuCorpus(native, native, "partial config", contracts.configuredWebGlIdentity({ webgl }))).toThrow(/Expected WebGL/);
    }
  });

  it("checks projected full-corpus probe hashes with the actual fingerprint baseline hash algorithm", () => {
    const contracts = gpuContracts(), native = nativeFixture();
    const source = fs.readFileSync(FINGERPRINT_BASELINE, "utf8");
    const hashSource = source.match(/function hash\(value\) \{[\s\S]*?\n  \}/)?.[0];
    expect(hashSource).toBeTruthy();
    const baselineHash = vm.runInNewContext(`(${hashSource})`, {}, { timeout: 1000 }) as (value: string) => string;
    const projected = contracts.projectNativeWebGlCorpus(native.webgl, EXPECTED_WEBGL);
    expect(projected).toEqual(managedFixture(native).webgl);
    expect(contracts.webGlProbeHash(native.webgl)).toBe(baselineHash(JSON.stringify(native.webgl)));
    expect(contracts.webGlProbeHash(projected)).toBe(baselineHash(JSON.stringify(projected)));
    expect(contracts.webGlProbeHash(projected)).not.toBe(contracts.webGlProbeHash(native.webgl));
  });

  it.each(["vendor", "renderer", "unmaskedVendor", "unmaskedRenderer"])("rejects a coherent window/worker WebGL %s mismatch instead of normalizing it away", field => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = structuredClone(native);
    for (const realm of WEBGL_REALMS) for (const kind of ["webgl1", "webgl2"] as const) {
      actual.webgl[realm][kind][field] += " synthetic-mismatch";
    }
    expect(actual.webgl.window).toEqual(actual.webgl.worker);
    expect(contracts.webGlCorpusSha256(actual.webgl.window)).not.toBe(contracts.webGlCorpusSha256(native.webgl.window));
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "managed fixture")).toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "pass-through fixture")).toThrow();
  });

  it.each(["vendor", "architecture", "device", "description", "subgroupMinSize", "subgroupMaxSize", "isFallbackAdapter"])("rejects a coherent WebGPU adapter/device %s identity mismatch", field => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = structuredClone(native);
    for (const realm of ["window", "worker"] as const) {
      const info = actual.webgpu[realm].adapter.info;
      info[field] = typeof info[field] === "boolean" ? !info[field] : typeof info[field] === "number" ? info[field] + 1 : info[field] + " synthetic-mismatch";
      actual.webgpu[realm].device.adapterInfo = structuredClone(info);
    }
    expect(actual.webgpu.window).toEqual(actual.webgpu.worker);
    expect(actual.webgpu.window.device.adapterInfo).toEqual(actual.webgpu.window.adapter.info);
    expect(contracts.webGpuCorpusSha256(actual.webgpu.window)).not.toBe(contracts.webGpuCorpusSha256(native.webgpu.window));
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "managed fixture")).toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "pass-through fixture")).toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(managedFixture(actual), native, "generated identity fixture", EXPECTED_WEBGL)).toThrow();
  });

  it.each(["adapter.features", "adapter.limits", "device.features", "device.limits"])("retains full native %s comparisons even when both realms agree", field => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = structuredClone(native);
    const [target, property] = field.split(".");
    for (const realm of ["window", "worker"] as const) {
      const value = actual.webgpu[realm][target][property];
      if (property === "features") value.push("synthetic-extra-feature");
      else value.maxTextureDimension2D += 1;
    }
    expect(actual.webgpu.window).toEqual(actual.webgpu.worker);
    expect(contracts.webGpuCorpusSha256(actual.webgpu.window)).not.toBe(contracts.webGpuCorpusSha256(native.webgpu.window));
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "managed fixture")).toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(managedFixture(actual), native, "generated identity fixture", EXPECTED_WEBGL)).toThrow();
  });

  it.each(["preferredCanvasFormat", "wgslLanguageFeatures", "error"])("preserves full WebGPU %s with a generated WebGL identity", field => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = managedFixture(native);
    for (const realm of ["window", "worker"] as const) {
      if (field === "wgslLanguageFeatures") actual.webgpu[realm][field].push("synthetic-language-feature");
      else actual.webgpu[realm][field] = "synthetic-mismatch";
    }
    expect(actual.webgpu.window).toEqual(actual.webgpu.worker);
    expect(() => contracts.verifyNativeGpuCorpus(actual, native, "generated identity fixture", EXPECTED_WEBGL)).toThrow();
  });

  it.each(["webgl1", "webgl2", "adapter", "device", "device.adapterInfo"])("rejects matching incomplete %s captures rather than passing vacuous equality", missing => {
    const contracts = gpuContracts(), actual = nativeFixture();
    if (missing.startsWith("webgl")) {
      for (const realm of WEBGL_REALMS) actual.webgl[realm][missing] = null;
    } else for (const realm of ["window", "worker"] as const) {
      if (missing === "device.adapterInfo") actual.webgpu[realm].device.adapterInfo = null;
      else actual.webgpu[realm][missing] = null;
    }
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual), "native fixture")).toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual), "generated identity fixture", EXPECTED_WEBGL)).toThrow();
  });

  it("wires complete captures to an explicit generated-identity contract, never actual-derived expectations", () => {
    const verifier = fs.readFileSync(VERIFIER, "utf8");
    expect(verifier).toContain("page.evaluate(captureWebGlCorpusInPage)");
    expect(verifier).toContain("page.evaluate(captureWebGpuCorpusInPage)");
    expect(verifier).toContain("await captureGpuCorpus(page, `pass-through");
    expect(verifier).toContain("verifyNativeGpuCorpus(run, nativeGpu,");
    expect(verifier).toContain("verifyNativeGpuCorpus(baseline, baseline,");
    expect(verifier).toContain("sameHostNativeSha256:");
    expect(verifier).toContain("managedFullCorpusSha256:");
    const file = ts.createSourceFile(VERIFIER, verifier, ts.ScriptTarget.Latest, true);
    const guard = file.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "verifyNativeGpuCorpus")!;
    expect(guard.parameters).toHaveLength(4);
    expect(guard.parameters[3].name.getText(file)).toBe("expectedWebgl");
    expect(guard.parameters[3].questionToken).toBeDefined();
    expect(verifier).toContain("configuredWebGlIdentity(config)");
    expect(verifier).toContain("configuredWebGlIdentity(first.configured)");
    expect(verifier).toContain("configuredWebGlIdentity(restart.configured)");
    expect(verifier).toContain("configuredWebGlIdentity(distinct.configured)");
    expect(verifier).toContain("simulated identity conformance, not physical GPU proof");
    // Standalone mode has no authoritative kernel architecture context. Only
    // production may supply it; don't guess from the current Node architecture.
    expect(verifier).not.toContain("process.arch");
    expect(verifier).not.toContain("os.arch()");
  });

  it("rejects Window/Worker disagreement even when the native fixture has the same disagreement", () => {
    const contracts = gpuContracts();
    const gl = nativeFixture();
    gl.webgl.worker.webgl1.renderer += " synthetic-worker-only";
    expect(() => contracts.verifyNativeGpuCorpus(gl, structuredClone(gl))).toThrow(/Window\/Worker full corpus/);
    const gpu = nativeFixture();
    gpu.webgpu.worker.adapter.info.description += " synthetic-worker-only";
    gpu.webgpu.worker.device.adapterInfo = structuredClone(gpu.webgpu.worker.adapter.info);
    expect(() => contracts.verifyNativeGpuCorpus(gpu, structuredClone(gpu))).toThrow(/Window\/Worker full corpus/);
  });

  it("rejects Window/Offscreen disagreement even if the native baseline shares it", () => {
    const contracts = gpuContracts(), native = nativeFixture();
    native.webgl.windowOffscreen.webgl2.unmaskedRenderer += " synthetic-offscreen-only";
    expect(() => contracts.verifyNativeGpuCorpus(native, structuredClone(native))).toThrow(/Window\/Offscreen full corpus/);
    expect(() => contracts.verifyNativeGpuCorpus(native, structuredClone(native), "managed fixture", EXPECTED_WEBGL)).toThrow(/Window\/Offscreen full corpus/);
  });

  it("requires actual adapter/device identity equality independently of matching native hashes", () => {
    const contracts = gpuContracts(), actual = nativeFixture();
    for (const realm of ["window", "worker"] as const) actual.webgpu[realm].device.adapterInfo.vendor += " synthetic-device-only";
    expect(actual.webgpu.window).toEqual(actual.webgpu.worker);
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual))).toThrow(/adapter\/device identity/);
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual), "managed fixture", EXPECTED_WEBGL)).toThrow(/adapter\/device identity/);
  });

  it("does not let E2E silently fall back from an explicit or cached 152 binary", () => {
    const helper = fs.readFileSync(E2E_HELPER, "utf8");
    expect(helper).toContain("Explicit Chromium binary does not exist");
    expect(helper).not.toContain("chromium-build-150");
    expect(helper).toContain('entry.match(/^chromium-(\\d+(?:\\.\\d+){3})$/)');
  });

  it("uses 152 names and full font canvas checks in the stock gate", () => {
    const gate = fs.readFileSync(GATE, "utf8");
    const capture = fs.readFileSync(CAPTURE, "utf8");
    expect(gate).toContain('const TARGET_VERSION = "152.0.7977.72"');
    expect(gate).toContain("Fonts canvas SHA == stock152");
    expect(gate).toContain("Fonts Window==Worker canvas");
    expect(gate).toContain("WebGPU corpus\", captureWebGpuCorpusInPage, 180_000");
    expect(gate).toContain('grantPermissions(["local-fonts"]');
    expect(gate).toContain("timed out after ${timeoutMs} ms");
    expect(gate).not.toContain("gate151.mjs");
    expect(capture).not.toContain("capture-stock151.mjs");
  });
});
