import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import * as observation from "../e2e/helpers/public-fingerprint-observation.js";
import type { PublicPageProtocol } from "../e2e/helpers/public-fingerprint-observation.js";

const RULE_URL = "https://creepjs.org/_next/static/chunks/595-c319ca3d76c54b23.js";
const RULE_SHA = "a8803f424495ddc2e481e73ed34da9463b88c15c097ed60aa60815ca693965f6";
const SIGNAL = "WebGL vendor mismatch between masked and unmasked";
const SITE_GPU = { vendor: "Site masked vendor", renderer: "Site masked renderer", unmaskedVendor: "Site unmasked vendor", unmaskedRenderer: "Site unmasked renderer" };
const LABELS = { vendor: "Vendor:", renderer: "Renderer:", unmaskedVendor: "Unmasked Vendor:", unmaskedRenderer: "GPU:" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/j1cAAAAASUVORK5CYII=", "base64");
const parent = fs.realpathSync(os.tmpdir()), root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "owned-public-observation-")));
const owner = fs.lstatSync(root);

interface Model {
  card?: boolean;
  duplicateCard?: boolean;
  missingField?: keyof typeof SITE_GPU;
  duplicateField?: keyof typeof SITE_GPU;
  invalidField?: { key: keyof typeof SITE_GPU; value: unknown };
  ruleResource?: boolean;
  malformedRuleResponse?: boolean;
  resourceFailure?: boolean;
  networkOverflow?: boolean;
  evaluationException?: boolean;
  predicateFlag?: boolean;
}
class OwnedPage implements PublicPageProtocol {
  readonly events = new Set<(method: string, params: Record<string, any>) => void>();
  readonly calls: string[] = [];
  constructor(readonly model: Model) {}
  onEvent(listener: (method: string, params: Record<string, any>) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  private emit(method: string, params: Record<string, any>) { for (const listener of this.events) listener(method, params); }
  private document() {
    const fields = Object.entries(SITE_GPU).filter(([key]) => key !== this.model.missingField).map(([key, value]) => ({
      children: [{ tagName: "SPAN", textContent: LABELS[key as keyof typeof LABELS] },
        { tagName: "SPAN", textContent: this.model.invalidField?.key === key ? this.model.invalidField.value : value }],
    }));
    const duplicateField = this.model.duplicateField;
    if (duplicateField) fields.push(fields.find(row => row.children[0].textContent === LABELS[duplicateField])!);
    const panel = { children: fields, isConnected: true };
    const control = { textContent: "WebGL\nWebGL 1.0", disabled: false,
      getAttribute: (name: string) => name === "aria-controls" ? "owned-webgl-panel" : name === "aria-expanded" ? "true" : null,
      hasAttribute: (name: string) => name === "aria-controls" || name === "aria-expanded",
      querySelectorAll: () => [{ textContent: "WebGL" }],
    };
    const cards = this.model.card === false ? [] : this.model.duplicateCard ? [control, control] : [control];
    const refresh = { textContent: "Refresh Fingerprint", disabled: false };
    return {
      body: { innerText: "Fingerprint ID\nOther collectors ready\n" + (this.model.predicateFlag ? SIGNAL : "") },
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === "button" ? [refresh, ...cards] : selector === '[role="alert"]' ? [] : selector.includes("aria-controls") ? cards : [],
      getElementById: (id: string) => id === "owned-webgl-panel" && cards.length ? panel : null,
      createElement: () => ({ getContext: () => ({ VENDOR: 1, RENDERER: 2,
        getExtension: () => ({ UNMASKED_VENDOR_WEBGL: 3, UNMASKED_RENDERER_WEBGL: 4 }),
        getParameter: (key: number) => ({ 1: "Independent vendor", 2: "Independent renderer", 3: "Independent unmasked vendor", 4: "Independent unmasked renderer" })[key],
      }) }),
    };
  }
  async send(method: string, params: Record<string, any> = {}) {
    this.calls.push(method);
    if (method === "Network.enable") return {};
    if (method === "Page.navigate") {
      expect(params.url).toBe("https://creepjs.org/checker#signals");
      if (this.model.ruleResource !== false) {
        this.emit("Network.requestWillBeSent", { requestId: "owned-rule", type: "Script", request: { url: RULE_URL } });
        this.emit("Network.responseReceived", { requestId: "owned-rule", type: "Script", response: { url: RULE_URL, status: 200 } });
        this.emit("Network.loadingFinished", { requestId: "owned-rule" });
      }
      if (this.model.resourceFailure) {
        this.emit("Network.requestWillBeSent", { requestId: "owned-failed", type: "Script", request: { url: "https://creepjs.org/owned-required.js" } });
        this.emit("Network.loadingFailed", { requestId: "owned-failed", errorText: "net::ERR_CONNECTION_CLOSED" });
      }
      if (this.model.networkOverflow) for (let n = 0; n < 257; n++) this.emit("Network.requestWillBeSent", { requestId: "owned-overflow-" + n, type: "Script", request: { url: "https://creepjs.org/owned-" + n + ".js" } });
      return { frameId: "owned-frame", loaderId: "owned-loader" };
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "owned-frame", loaderId: "owned-loader", url: "https://creepjs.org/checker#signals" } } };
    if (method === "Runtime.evaluate") {
      if (this.model.evaluationException) return { exceptionDetails: { text: "Owned synthetic probe exception" }, result: {} };
      const result = vm.runInNewContext(params.expression, { document: this.document(), performance: {
        getEntriesByType: () => this.model.ruleResource === false ? [] : [{ name: RULE_URL, initiatorType: "script" }],
      } }, { timeout: 1000 });
      return { result: { value: JSON.parse(JSON.stringify(result)) } };
    }
    if (method === "Network.getResponseBody") {
      expect(params.requestId).toBe("owned-rule");
      return this.model.malformedRuleResponse ? { body: 17, base64Encoded: false } : { body: "owned synthetic changed rule body", base64Encoded: false };
    }
    if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
    throw new Error("Unexpected owned protocol command: " + method);
  }
}
function assessment(input: unknown): string {
  const fn = (observation as unknown as Record<string, unknown>).assessCreepJsWebGlObservation;
  expect(typeof fn).toBe("function");
  return (fn as (value: unknown) => string)(input);
}
function covered() {
  return { collection: "completed", webglVendorMismatch: false, siteWebGl: { ...SITE_GPU },
    siteWebGlCoverage: { state: "complete", cardCount: 1, fields: 4 },
    ruleChunkObserved: true, ruleScriptVerified: true, ruleSourceSha256: RULE_SHA, ruleObservedSha256: RULE_SHA,
    resourceFailures: [], networkObservationOverflow: false, gpu: null };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", () => { throw new Error("Network forbidden in owned public-observation unit fixture"); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => {
  const current = fs.lstatSync(root);
  expect([current.dev, current.ino, current.uid]).toEqual([owner.dev, owner.ino, owner.uid]);
  expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
  expect(path.dirname(root)).toBe(parent);
  fs.rmSync(root, { recursive: true });
});

async function observe(model: Model, name: string) {
  const page = new OwnedPage(model);
  const pending = observation.observeCreepJs(page, root, name, () => {}).then(result => ({ result }), error => ({ error }));
  await vi.runAllTimersAsync();
  const outcome = await pending;
  if ("error" in outcome) throw outcome.error;
  const result = outcome.result;
  expect(page.events.size).toBe(0);
  return { result, page };
}

describe("public CreepJS observation fails closed on missing target coverage", () => {
  it.each([
    ["generic-ready-without-webgl", { card: false }],
    ["missing-current-rule", { ruleResource: false }],
    ["duplicate-webgl-card", { duplicateCard: true }],
    ["duplicate-site-field", { duplicateField: "vendor" }],
    ["required-resource-failure", { resourceFailure: true }],
    ["network-observer-overflow", { networkOverflow: true }],
    ["changed-rule-body", {}],
    ["malformed-rule-body", { malformedRuleResponse: true }],
    ["probe-exception", { evaluationException: true }],
  ] as Array<[string, Model]>)("keeps %s inconclusive despite an available independent canvas", async (name, model) => {
    const { result } = await observe(model, name);
    expect(result.collection).toBe("inconclusive");
    expect(result.webglVendorMismatch).toBeNull();
    expect(assessment(result)).toBe("INCONCLUSIVE");
  });

  it.each(Object.keys(SITE_GPU) as Array<keyof typeof SITE_GPU>)("requires the site's %s field", async key => {
    const { result } = await observe({ missingField: key }, "missing-" + key);
    expect(result.collection).toBe("inconclusive"); expect(result.webglVendorMismatch).toBeNull();
    expect(assessment(result)).toBe("INCONCLUSIVE");
  });

  it.each(["", " ", "bad" + String.fromCharCode(0) + "value", 17] as unknown[])("does not accept an invalid site field (%#)", async value => {
    const { result } = await observe({ invalidField: { key: "vendor", value } }, "invalid-field-" + String(typeof value) + "-" + String(value).length);
    expect(result.collection).toBe("inconclusive"); expect(result.webglVendorMismatch).toBeNull();
  });

  it("retains required-resource failure evidence instead of returning completed", async () => {
    const { result } = await observe({ resourceFailure: true }, "resource-evidence");
    expect(result).toMatchObject({ collection: "inconclusive", resourceFailures: [{ kind: "script", host: "creepjs.org", code: "net::ERR_CONNECTION_CLOSED" }] });
  });

  it("uses site card fields as the target observation, never the independent canvas", async () => {
    const { result, page } = await observe({}, "site-fields-not-canvas");
    expect(result).toMatchObject({ siteWebGl: SITE_GPU, siteWebGlCoverage: { state: "complete", cardCount: 1, fields: 4 } });
    expect(page.calls).toContain("Network.getResponseBody");
    expect(result).toMatchObject({ collection: "inconclusive", ruleScriptVerified: false });
  });

  it("accepts only explicit site coverage and verified current script in the final gate", () => {
    expect(assessment(covered())).toBe("PASS");
    expect(assessment({ ...covered(), webglVendorMismatch: true })).toBe("FAIL");
    for (const patch of [
      { collection: "inconclusive" }, { collection: "failed" }, { webglVendorMismatch: null },
      { siteWebGl: null }, { siteWebGl: { ...SITE_GPU, renderer: "" } }, { siteWebGlCoverage: { state: "missing", cardCount: 0, fields: 0 } },
      { ruleChunkObserved: false }, { ruleScriptVerified: false }, { ruleObservedSha256: "0".repeat(64) },
      { ruleSourceSha256: "0".repeat(64) }, { resourceFailures: [{ kind: "script" }] }, { networkObservationOverflow: true },
    ]) expect(assessment({ ...covered(), ...patch })).toBe("INCONCLUSIVE");
    expect(assessment({ collection: "completed", webglVendorMismatch: false, gpu: SITE_GPU })).toBe("INCONCLUSIVE");
  });
});

describe("public Ping0 observation preserves required-resource uncertainty", () => {
  it.each(["required-resource-failed", "network-observation-overflow", "healthy"] as const)("does not turn a finished flag into acceptance with %s", async mode => {
    const listeners = new Set<(method: string, params: Record<string, any>) => void>();
    const emit = (method: string, params: Record<string, any>) => { for (const listener of listeners) listener(method, params); };
    const captured = { finished: true, reportId: "owned-unit-report", score: 0, findings: [], rows: {
      "dns.resolver_count": { id: "dns.resolver_count", pending: false, fail: false, value: 1 },
      "xc.dns_blackhole": { id: "xc.dns_blackhole", pending: false, fail: false, value: { resolver_count: 1 } },
    } };
    const page: PublicPageProtocol = {
      onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async send(method, params = {}) {
        if (method === "Network.enable") return {};
        if (method === "Page.navigate") {
          expect(params.url).toBe("https://ping0.cc/env");
          if (mode === "required-resource-failed") {
            emit("Network.requestWillBeSent", { requestId: "owned-ping0-failed", type: "Script", request: { url: "https://cdn.ping0.cc/owned-required.js" } });
            emit("Network.loadingFailed", { requestId: "owned-ping0-failed", errorText: "net::ERR_CONNECTION_CLOSED" });
          }
          if (mode === "network-observation-overflow") for (let n = 0; n < 257; n++) emit("Network.requestWillBeSent", {
            requestId: "owned-ping0-overflow-" + n, type: "Script", request: { url: "https://cdn.ping0.cc/owned-" + n + ".js" },
          });
          return { frameId: "owned-frame", loaderId: "owned-loader" };
        }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { url: "https://ping0.cc/env" } } };
        if (method === "Runtime.evaluate") {
          expect(String(params.expression)).toContain("#envdetect-app");
          return { result: { value: String(params.expression).includes("score:") ? captured : { finished: true } } };
        }
        if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
        throw new Error("Unexpected owned Ping0 protocol command: " + method);
      },
    };
    const pending = observation.observePing0(page, root, "ping0-" + mode, () => {}).then(result => ({ result }), error => ({ error }));
    await vi.runAllTimersAsync();
    const outcome = await pending;
    if ("error" in outcome) throw outcome.error;
    expect(listeners.size).toBe(0);
    if (mode === "healthy") {
      expect(outcome.result).toMatchObject({ collection: "completed", observedFinished: true, assessment: { status: "PASS" } });
    } else {
      expect(outcome.result).toMatchObject({ collection: "inconclusive", reason: mode, observedFinished: true, assessment: { status: "INCONCLUSIVE" } });
    }
  });
});
