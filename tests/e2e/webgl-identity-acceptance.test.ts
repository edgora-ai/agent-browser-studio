// Opt-in observation, NOT installed-App, physical-GPU, Ping0 or live CreepJS acceptance.
// Outer supervisor: fresh EMPTY canonical ABS_S3_COOKIE_LOGIN_ROOT below the fixed
// ABS_S3_COOKIE_LOGIN_BUDGET_ROOT; explicit AGENT_BROWSER_CHROMIUM_BINARY_PATH;
// ABS_WEBGL_IDENTITY_ACCEPTANCE=1. No downloads/builds or product source mutation.
import { describe, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildBrowserFingerprintArg, buildBrowserFingerprintConfig, AGENT_BROWSER_FINGERPRINT_SWITCH } from "../../src/main/services/browser-fingerprint-config.js";
import { readChromiumGpuContext } from "../../src/main/services/browser/chromium-gpu-context.js";
import { WebGlNativeHarness, ensure, safeFailure } from "./helpers/webgl-native-harness.js";
import { assessCreepJsWebGlObservation, observeCreepJs, observePing0 } from "./helpers/public-fingerprint-observation.js";

const PUBLIC_SITES = process.env.ABS_PUBLIC_FINGERPRINT_SITES === "1";

type Identity = { vendor: string; renderer: string; unmaskedVendor: string; unmaskedRenderer: string };
type Contexts = { webgl1: Identity | null; webgl2: Identity | null };
type Capture = { window: Contexts; windowOffscreen: Contexts; worker: Contexts };
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CORPUS = "patches/chromium/corpora-152/stock-chrome-152.0.7977.64.json";
const PIN_FILES = ["src/main/services/browser-fingerprint-config.ts", "src/main/services/browser/chromium-gpu-context.ts",
  "src/main/services/browser/chromium-args-factory.ts", "src/main/services/browser/webrtc-policy.ts", "src/main/services/browser/webrtc-preferences.ts",
  "src/tools/ping0-acceptance.ts", "tests/e2e/helpers/public-fingerprint-observation.ts",
  "tests/e2e/helpers/webgl-native-harness.ts", "tests/e2e/webgl-identity-acceptance.test.ts", CORPUS];
const pins = () => Object.fromEntries(PIN_FILES.map(file => [file, createHash("sha256").update(fs.readFileSync(path.join(REPO, file))).digest("hex")]));
const REALMS = ["window", "windowOffscreen", "worker"] as const, KINDS = ["webgl1", "webgl2"] as const;
const FIELDS = ["vendor", "renderer", "unmaskedVendor", "unmaskedRenderer"] as const;

// Self-contained serialization into the owned local page and its own Blob Worker.
// Only the four public WebGL strings are collected, no storage/Cookies/site state.
async function captureIdentities(): Promise<Capture> {
  function read(canvas: HTMLCanvasElement | OffscreenCanvas, kind: "webgl" | "webgl2"): Identity | null {
    const gl = canvas.getContext(kind) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const result = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
    gl.getExtension("WEBGL_lose_context")?.loseContext(); return result;
  }
  const windowIdentity = { webgl1: read(document.createElement("canvas"), "webgl"), webgl2: read(document.createElement("canvas"), "webgl2") };
  const windowOffscreen = { webgl1: read(new OffscreenCanvas(8, 8), "webgl"), webgl2: read(new OffscreenCanvas(8, 8), "webgl2") };
  const code = `const read=${read.toString()};self.onmessage=()=>{try{self.postMessage({webgl1:read(new OffscreenCanvas(8,8),'webgl'),webgl2:read(new OffscreenCanvas(8,8),'webgl2')});}catch{self.postMessage({failure:true});}};`;
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })), worker = new Worker(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workerIdentity = await new Promise<Contexts>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("OWNED_WEBGL_WORKER_TIMEOUT")), 8000);
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => { event.preventDefault(); reject(new Error("OWNED_WEBGL_WORKER_FAILED")); };
      worker.postMessage(null);
    });
    return { window: windowIdentity, windowOffscreen, worker: workerIdentity };
  } finally { if (timer) clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); }
}
function validateCapture(value: unknown): asserts value is Capture {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "OWNED_WEBGL_CAPTURE_INVALID");
  ensure(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...REALMS].sort()), "OWNED_WEBGL_REALM_KEYS_INVALID");
  const capture = value as Capture;
  for (const realm of REALMS) {
    ensure(capture[realm] !== null && typeof capture[realm] === "object" &&
      JSON.stringify(Object.keys(capture[realm]).sort()) === JSON.stringify([...KINDS].sort()), "OWNED_WEBGL_KIND_KEYS_INVALID");
    for (const kind of KINDS) {
      const identity = capture[realm][kind];
      ensure(identity !== null && typeof identity === "object" && JSON.stringify(Object.keys(identity).sort()) === JSON.stringify([...FIELDS].sort()), "OWNED_WEBGL_CONTEXT_UNAVAILABLE");
      for (const field of FIELDS) ensure(typeof identity[field] === "string" && identity[field].length > 0 && identity[field].length <= 1024 &&
        !/[\x00-\x1f\x7f]/.test(identity[field]), "OWNED_WEBGL_FIELD_UNAVAILABLE");
      ensure(JSON.stringify(identity) === JSON.stringify(capture.window[kind]), "OWNED_WEBGL_REALM_IDENTITY_MISMATCH");
    }
  }
}
// Exact current checker rule supplied from the public chunk, not a browser
// invariant: even stock WebKit / Google Inc. (Apple) triggers this condition.
function replayVendorRule(identity: Identity): boolean {
  if (identity.unmaskedVendor && identity.unmaskedRenderer && identity.vendor) {
    const masked = identity.vendor.toLowerCase(), unmasked = identity.unmaskedVendor.toLowerCase();
    return masked.length > 0 && !unmasked.includes(masked) && masked !== "google inc.";
  }
  return false;
}
function ruleObservation(capture: Capture) {
  return Object.fromEntries(REALMS.map(realm => [realm, Object.fromEntries(KINDS.map(kind => [kind, {
    webglVendorMismatch: replayVendorRule(capture[realm][kind]!),
    maskedEqualsUnmasked: capture[realm][kind]!.vendor === capture[realm][kind]!.unmaskedVendor,
  }]))]));
}

describe.skipIf(process.env.ABS_WEBGL_IDENTITY_ACCEPTANCE !== "1").sequential("same-host native WebGL identity observation", () => {
  it("observes stock and generated identity in WebGL1/2 across Window, Offscreen and Worker without equating masked and unmasked vendors", async () => {
    const harness = new WebGlNativeHarness(PUBLIC_SITES), before = pins();
    const receipt: Record<string, any> = { schema: "same-host-native-webgl-identity/v1", status: "running", phase: "fixture", startedAt: new Date().toISOString(),
      sourcePins: { before }, budget: { initial: harness.initialBudget },
      rule: { source: "https://creepjs.org/_next/static/chunks/595-c319ca3d76c54b23.js",
        sha256: "a8803f424495ddc2e481e73ed34da9463b88c15c097ed60aa60815ca693965f6", authority: "local replay of source-derived predicate; not live website acceptance" },
      limitations: ["same selected native executable with two fresh profiles on one Mac, not two machines or a separate stock Chrome binary",
        "Node driver with production argument/config builders; not installed App or production launch/discovery/stop acceptance",
        PUBLIC_SITES ? "explicit public-site observations through bounded strict proxy; no user profile/storage access; headless, not visible-desktop acceptance" : "only owned loopback proxy/local page; no live Ping0/CreepJS or user profile/storage access",
        "stock WebGL fields are public native runtime observations; generated identity fields are synthetic persona values, not physical GPU proof",
        "historical corpus checks native masked field family only; rule replay is not a browser invariant or evidence of malicious automation"] };
    try {
      const gpuContext = readChromiumGpuContext(harness.binary);
      ensure(gpuContext.hostPlatform === "darwin" && gpuContext.hostArchitecture === "arm64" && gpuContext.kernelArchitecture === "arm64" &&
        gpuContext.architectureObservation === "observed", "OWNED_MANAGED_MAC_CONTEXT_UNAVAILABLE");
      await harness.start(); receipt.phase = "stock-native-observation";
      const stock = await harness.launch("stock"), stockCapture = await harness.observe(stock, `(${captureIdentities.toString()})()`);
      validateCapture(stockCapture);
      const historical = JSON.parse(fs.readFileSync(path.join(REPO, CORPUS), "utf8"));
      ensure(stock.version?.split(".")[0] === historical.browserVersion.match(/\b(\d+)\./)?.[1], "OWNED_NATIVE_CORPUS_MAJOR_MISMATCH");
      for (const realm of REALMS) for (const kind of KINDS) for (const field of ["vendor", "renderer"] as const) {
        ensure(stockCapture[realm][kind]![field] === historical.webgl.window[kind][field], "OWNED_NATIVE_MASKED_FAMILY_MISMATCH");
      }
      receipt.stock = { launchMode: "off, no fingerprint config/identity switches", capture: stockCapture, checkerRuleReplay: ruleObservation(stockCapture) };
      if (PUBLIC_SITES) {
        receipt.phase = "stock-creepjs-public-observation"; receipt.publicSites = {};
        try { receipt.publicSites.stockCreepJs = await observeCreepJs(stock.page!, harness.root, "stock", () => { harness.guard(); }); }
        catch (error) { receipt.publicSites.stockCreepJs = { collection: "failed", reason: safeFailure(error, "OWNED_PUBLIC_OBSERVATION_FAILED") }; }
        harness.guard();
      }
      await harness.close(stock); harness.guard(true); receipt.phase = "managed-native-observation";
      const meta = { fingerprintSeed: 730147, platform: "macos" as const, fingerprintMode: "managed" as const, locale: "en-US", timezone: "UTC", webrtcMode: PUBLIC_SITES ? "proxy-only" as const : "disable" as const };
      const config = buildBrowserFingerprintConfig(meta, stock.version!, null, "chromium", gpuContext);
      ensure(config.webgl.vendor.length > 0 && config.webgl.renderer.length > 0, "OWNED_GENERATED_WEBGL_NOT_MANAGED");
      const arg = buildBrowserFingerprintArg(meta, stock.version!, AGENT_BROWSER_FINGERPRINT_SWITCH, null, "chromium", gpuContext);
      ensure(JSON.stringify(JSON.parse(Buffer.from(arg.slice(AGENT_BROWSER_FINGERPRINT_SWITCH.length), "base64url").toString("utf8"))) === JSON.stringify(config), "OWNED_GENERATED_CONFIG_ARG_MISMATCH");
      const managed = await harness.launch("managed", arg), managedCapture = await harness.observe(managed, `(${captureIdentities.toString()})()`);
      validateCapture(managedCapture); ensure(managed.version === stock.version, "OWNED_NATIVE_SOFTWARE_CHANGED");
      for (const realm of REALMS) for (const kind of KINDS) {
        const actual = managedCapture[realm][kind]!, baseline = stockCapture[realm][kind]!;
        ensure(actual.vendor === baseline.vendor && actual.renderer === baseline.renderer, "OWNED_MANAGED_MASKED_SURFACE_CHANGED");
        ensure(actual.unmaskedVendor === config.webgl.vendor && actual.unmaskedRenderer === config.webgl.renderer, "OWNED_GENERATED_IDENTITY_NOT_OBSERVED");
      }
      receipt.generated = { schemaVersion: config.schemaVersion, platform: config.platform, hardwareProfile: config.hardwareProfile, webgl: config.webgl, gpuContext };
      receipt.managed = { capture: managedCapture, checkerRuleReplay: ruleObservation(managedCapture) };
      receipt.comparison = { allSixContextsCapturedPerChild: true, nativeMaskedFamilyMatchesHistoricalCorpus: true,
        maskedFieldsUnchanged: true, generatedUnmaskedIdentityMatches: true,
        checkerRuleReplaySameForStockAndManaged: JSON.stringify(ruleObservation(stockCapture)) === JSON.stringify(ruleObservation(managedCapture)),
        liveCreepJsAcceptance: "not-executed", livePing0Acceptance: "not-executed" };
      receipt.localIdentityObservation = "passed";
      if (PUBLIC_SITES) {
        receipt.phase = "managed-creepjs-public-observation";
        try { receipt.publicSites.managedCreepJs = await observeCreepJs(managed.page!, harness.root, "managed", () => { harness.guard(); }); }
        catch (error) { receipt.publicSites.managedCreepJs = { collection: "failed", reason: safeFailure(error, "OWNED_PUBLIC_OBSERVATION_FAILED") }; }
        harness.guard(); receipt.phase = "managed-ping0-public-observation";
        try { receipt.publicSites.managedPing0 = await observePing0(managed.page!, harness.root, "managed", () => { harness.guard(); }); }
        catch (error) { receipt.publicSites.managedPing0 = { collection: "failed", reason: safeFailure(error, "OWNED_PUBLIC_OBSERVATION_FAILED") }; }
        harness.guard();
        receipt.comparison.liveCreepJsAssessment = assessCreepJsWebGlObservation(receipt.publicSites.managedCreepJs);
        receipt.comparison.liveCreepJsAcceptance = receipt.comparison.liveCreepJsAssessment === "PASS" ? "reported-signal-not-present" : "not-passed";
        receipt.comparison.livePing0Acceptance = receipt.publicSites.managedPing0.assessment?.status ?? "INCONCLUSIVE";
      }
      await harness.close(managed); receipt.phase = "complete";
      receipt.status = !PUBLIC_SITES || receipt.comparison.liveCreepJsAcceptance === "reported-signal-not-present" && receipt.comparison.livePing0Acceptance === "PASS" ? "passed" : "failed";
      if (receipt.status !== "passed") receipt.error = "OWNED_PUBLIC_SITE_ACCEPTANCE_NOT_MET";
    } catch (error) { receipt.status = "failed"; receipt.error = safeFailure(error, "OWNED_WEBGL_OBSERVATION_FAILED_AT_" + receipt.phase.replace(/-/g, "_").toUpperCase()); }
    finally {
      try {
        receipt.sourcePins.after = pins();
        if (JSON.stringify(receipt.sourcePins.after) !== JSON.stringify(before)) { receipt.status = "failed"; receipt.error = "OWNED_SOURCE_CHANGED_DURING_ACCEPTANCE"; }
      } catch { receipt.status = "failed"; receipt.error = "OWNED_FINAL_SOURCE_PINS_UNAVAILABLE"; }
      await harness.finish(receipt);
    }
  }, PUBLIC_SITES ? 540_000 : 240_000);
});
