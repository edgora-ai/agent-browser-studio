import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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

describe("Chromium 152 verification guards", () => {
  it("pins the verifier to fail-closed Chromium 152 capability references", () => {
    const verifier = fs.readFileSync(VERIFIER, "utf8");
    expect(verifier).toContain('const TARGET_CHROMIUM_VERSION = "152.0.7977.72"');
    expect(verifier).toContain("Unable to execute Chromium --version");
    expect(verifier).toContain("Unable to parse Chromium version");
    expect(verifier).not.toContain('|| "149.0.7827.22"');
    expect(verifier).not.toContain('return "149.0.7827.22"');
    expect(verifier).toContain("stockChrome152Sha256");
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

  it("derives the pinned WebGPU SHA from the checked-in stock-152 corpus", () => {
    const corpus = JSON.parse(fs.readFileSync(STOCK_CORPUS, "utf8"));
    const context = corpus.webgpu.window;
    const normalized = {
      available: context.available,
      adapter: context.adapter
        ? { features: context.adapter.features, limits: context.adapter.limits }
        : null,
      device: context.device
        ? { features: context.device.features, limits: context.device.limits }
        : null,
      preferredCanvasFormat: context.preferredCanvasFormat,
      wgslLanguageFeatures: context.wgslLanguageFeatures,
      error: context.error,
    };
    expect(sha(normalized)).toBe("d6f8c588d2270ff32761fa2d512820f27eb932248a492a536696bc60b42c4999");
    expect(fs.readFileSync(VERIFIER, "utf8")).toContain(sha(normalized));
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
