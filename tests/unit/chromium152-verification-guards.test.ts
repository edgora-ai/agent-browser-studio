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

interface GpuContracts {
  webGlCorpusSha256(contexts: unknown): string;
  webGpuCorpusSha256(context: unknown): string;
  verifyNativeGpuCorpus(actual: unknown, native: unknown, label?: string): void;
}
function gpuContracts(): GpuContracts {
  const source = fs.readFileSync(VERIFIER, "utf8");
  const file = ts.createSourceFile(VERIFIER, source, ts.ScriptTarget.Latest, true);
  const functions = ["fail", "expect", "expectEqual", "webGlCorpusSha256", "webGpuCorpusSha256", "verifyNativeGpuCorpus"].map(name => {
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
  vm.runInNewContext(compiled, context, { timeout: 1000 });
  return context.exports;
}
function nativeFixture() {
  // Stock data is a complete inert capture fixture, NOT a pinned release oracle.
  const corpus = JSON.parse(fs.readFileSync(STOCK_CORPUS, "utf8"));
  return { webgl: corpus.webgl, webgpu: corpus.webgpu };
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

  it("hashes full captured identities and accepts only a matching healthy native window/worker fixture", () => {
    const contracts = gpuContracts(), native = nativeFixture();
    expect(native.webgl.window.webgl1).toBeTruthy();
    expect(native.webgl.window.webgl2).toBeTruthy();
    expect(native.webgpu.window.available).toBe(true);
    expect(native.webgpu.window.device).toBeTruthy();
    for (const realm of ["window", "worker"] as const) {
      expect(contracts.webGlCorpusSha256(native.webgl[realm])).toBe(sha(native.webgl[realm]));
      expect(contracts.webGpuCorpusSha256(native.webgpu[realm])).toBe(sha(native.webgpu[realm]));
      expect(native.webgpu[realm].device.adapterInfo).toEqual(native.webgpu[realm].adapter.info);
    }
    expect(() => contracts.verifyNativeGpuCorpus(structuredClone(native), native, "managed fixture")).not.toThrow();
    expect(() => contracts.verifyNativeGpuCorpus(structuredClone(native), native, "pass-through fixture")).not.toThrow();
  });

  it.each(["vendor", "renderer", "unmaskedVendor", "unmaskedRenderer"])("rejects a coherent window/worker WebGL %s mismatch instead of normalizing it away", field => {
    const contracts = gpuContracts(), native = nativeFixture(), actual = structuredClone(native);
    for (const realm of ["window", "worker"] as const) for (const kind of ["webgl1", "webgl2"] as const) {
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
  });

  it.each(["webgl1", "webgl2", "adapter", "device", "device.adapterInfo"])("rejects matching incomplete %s captures rather than passing vacuous equality", missing => {
    const contracts = gpuContracts(), actual = nativeFixture();
    for (const realm of ["window", "worker"] as const) {
      if (missing.startsWith("webgl")) actual.webgl[realm][missing] = null;
      else if (missing === "device.adapterInfo") actual.webgpu[realm].device.adapterInfo = null;
      else actual.webgpu[realm][missing] = null;
    }
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual), "native fixture")).toThrow();
  });

  it("keeps real managed/pass-through Window/Worker GPU captures wired to full same-host validation", () => {
    const verifier = fs.readFileSync(VERIFIER, "utf8");
    expect(verifier).toContain("page.evaluate(captureWebGlCorpusInPage)");
    expect(verifier).toContain("page.evaluate(captureWebGpuCorpusInPage)");
    expect(verifier).toContain("await captureGpuCorpus(page, `pass-through");
    expect(verifier).toContain("verifyNativeGpuCorpus(run, nativeGpu,");
    expect(verifier).toContain("verifyNativeGpuCorpus(baseline, baseline,");
    expect(verifier).toContain("sameHostNativeSha256:");
    expect(verifier).toContain("managedFullCorpusSha256:");
    expect(verifier).not.toMatch(/\bgpu(?:Vendor|Renderer):/);
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

  it("requires actual adapter/device identity equality independently of matching native hashes", () => {
    const contracts = gpuContracts(), actual = nativeFixture();
    for (const realm of ["window", "worker"] as const) actual.webgpu[realm].device.adapterInfo.vendor += " synthetic-device-only";
    expect(actual.webgpu.window).toEqual(actual.webgpu.worker);
    expect(() => contracts.verifyNativeGpuCorpus(actual, structuredClone(actual))).toThrow(/adapter\/device identity/);
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
