import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { assessPing0Findings } from "../../../src/tools/ping0-acceptance.js";

// Read-only probes of explicitly requested public pages. These do not replace
// their collectors, change their results, or turn navigation into acceptance.
export interface PublicPageProtocol {
  send(method: string, params?: Record<string, unknown>, timeout?: number): Promise<Record<string, any>>;
  onEvent(listener: (method: string, params: Record<string, any>) => void): () => void;
}

function requiredResources(page: PublicPageProtocol, host: "creepjs.org" | "ping0.cc") {
  const tracked = new Map<string, { kind: "document" | "script"; host: string }>();
  const failures: Array<{ kind: string; host: string; code?: string; status?: number }> = [];
  const ruleRequests = new Map<string, { status: number | null; finished: boolean }>();
  let overflow = false;
  const stop = page.onEvent((method, data) => {
    if (method === "Network.requestWillBeSent" && typeof data.request?.url === "string") {
      let url: URL;
      try { url = new URL(data.request.url); } catch { overflow = true; return; }
      const relevant = data.type === "Document" && url.hostname === host || data.type === "Script" &&
        (url.hostname === host || host === "ping0.cc" && url.hostname === "cdn.ping0.cc");
      if (!relevant) return;
      if (tracked.size >= 256 || typeof data.requestId !== "string") { overflow = true; return; }
      tracked.set(data.requestId, { kind: data.type === "Document" ? "document" : "script", host: url.hostname });
      if (host === "creepjs.org" && data.type === "Script" && url.href === CREEPJS_RULE_URL) {
        if (ruleRequests.size >= 4) overflow = true;
        else ruleRequests.set(data.requestId, { status: null, finished: false });
      }
    }
    const rule = ruleRequests.get(data.requestId);
    if (rule && method === "Network.responseReceived" && data.response?.url === CREEPJS_RULE_URL && Number.isInteger(data.response.status)) rule.status = data.response.status;
    if (rule && method === "Network.loadingFinished") rule.finished = true;
    const request = tracked.get(data.requestId);
    if (!request) return;
    if (method === "Network.loadingFailed") {
      if (failures.length < 32) failures.push({ ...request, code: safeNavigationError(data.errorText) || "OWNED_PUBLIC_RESOURCE_FAILED" });
      else overflow = true;
      tracked.delete(data.requestId);
    } else if (method === "Network.responseReceived" && data.response?.status >= 400) {
      if (failures.length < 32) failures.push({ ...request, status: data.response.status });
      else overflow = true;
    } else if (method === "Network.loadingFinished") tracked.delete(data.requestId);
  });
  return { failures, stop, overflow: () => overflow,
    currentRuleRequest: () => ruleRequests.size === 1 ? [...ruleRequests].find(([, rule]) => rule.finished && rule.status === 200)?.[0] ?? null : null };
}

const CREEPJS = "https://creepjs.org/checker#signals";
const PING0 = "https://ping0.cc/env";
const MISMATCH = "WebGL vendor mismatch between masked and unmasked";
const CREEPJS_RULE_URL = "https://creepjs.org/_next/static/chunks/595-c319ca3d76c54b23.js";
const CREEPJS_RULE_SHA256 = "a8803f424495ddc2e481e73ed34da9463b88c15c097ed60aa60815ca693965f6";
const WEBGL_FIELDS = ["vendor", "renderer", "unmaskedVendor", "unmaskedRenderer"] as const;
const validWebGlText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);

/** This final gate consumes site-owned coverage, not a separately created canvas.
 * Unknown/missing coverage and unverified rule bytes can never prove acceptance. */
export function assessCreepJsWebGlObservation(value: unknown): "PASS" | "FAIL" | "INCONCLUSIVE" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "INCONCLUSIVE";
  const result = value as Record<string, any>, coverage = result.siteWebGlCoverage, fields = result.siteWebGl;
  if (result.collection !== "completed" || !coverage || coverage.state !== "complete" || coverage.cardCount !== 1 || coverage.fields !== 4 ||
      !fields || typeof fields !== "object" || Array.isArray(fields) || !WEBGL_FIELDS.every(field => validWebGlText(fields[field])) ||
      result.ruleChunkObserved !== true || result.ruleScriptVerified !== true || result.ruleSourceSha256 !== CREEPJS_RULE_SHA256 || result.ruleObservedSha256 !== CREEPJS_RULE_SHA256 ||
      !Array.isArray(result.resourceFailures) || result.resourceFailures.length !== 0 || result.networkObservationOverflow !== false ||
      typeof result.webglVendorMismatch !== "boolean") return "INCONCLUSIVE";
  return result.webglVendorMismatch ? "FAIL" : "PASS";
}

async function verifyCurrentRule(page: PublicPageProtocol, requestId: string | null) {
  if (!requestId) return { verified: false, sha256: null, reason: "current-rule-not-observed" };
  try {
    // Only this exact public Script response is inspected; never request page
    // bodies, headers, Cookies or unrelated responses from the debug target.
    const response = await page.send("Network.getResponseBody", { requestId });
    if (typeof response.body !== "string" || typeof response.base64Encoded !== "boolean" || response.body.length > 256 * 1024 ||
        response.base64Encoded && !/^[A-Za-z0-9+/]*={0,2}$/.test(response.body)) return { verified: false, sha256: null, reason: "current-rule-body-invalid" };
    const bytes = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
    if (!bytes.length || bytes.length > 128 * 1024 || response.base64Encoded && bytes.toString("base64") !== response.body) return { verified: false, sha256: null, reason: "current-rule-body-invalid" };
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { verified: digest === CREEPJS_RULE_SHA256, sha256: digest, reason: digest === CREEPJS_RULE_SHA256 ? null : "current-rule-bytes-changed" };
  } catch { return { verified: false, sha256: null, reason: "current-rule-body-unavailable" }; }
}

async function evaluate(page: PublicPageProtocol, expression: string): Promise<any> {
  const response = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails || !response.result || response.result.subtype === "error") throw new Error("OWNED_PUBLIC_PROBE_FAILED");
  return response.result.value;
}

async function checkedOrigin(page: PublicPageProtocol, expected: string): Promise<void> {
  const tree = await page.send("Page.getFrameTree");
  const url = tree.frameTree?.frame?.url;
  if (typeof url !== "string" || new URL(url).origin !== expected) throw new Error("OWNED_PUBLIC_ORIGIN_CHANGED");
}

function safeNavigationError(value: unknown): string | null {
  return typeof value === "string" && /^net::ERR_[A-Z0-9_]+$/.test(value) ? value : value ? "OWNED_PUBLIC_NAVIGATION_FAILED" : null;
}

async function screenshot(page: PublicPageProtocol, root: string, label: string) {
  const response = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (typeof response.data !== "string" || response.data.length > 6 * 1024 * 1024) throw new Error("OWNED_PUBLIC_SCREENSHOT_INVALID");
  const bytes = Buffer.from(response.data, "base64");
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.length > 4 * 1024 * 1024) throw new Error("OWNED_PUBLIC_SCREENSHOT_INVALID");
  const file = path.join(root, label + ".png");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const read = fs.readFileSync(file);
  if (!read.equals(bytes)) throw new Error("OWNED_PUBLIC_SCREENSHOT_READBACK_FAILED");
  return { file: path.basename(file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const CREEPJS_STATE = `(() => {
  const text = document.body?.innerText || '';
  const buttons = [...document.querySelectorAll('button')];
  const refresh = buttons.filter(b => b.textContent?.trim() === 'Refresh Fingerprint');
  const progress = document.querySelector('[aria-label="Browser fingerprint collection progress"]');
  const error = [...document.querySelectorAll('[role="alert"]')].some(e => /Fingerprint collection failed/.test(e.textContent || ''));
  const ready = refresh.length === 1 && !refresh[0].disabled && !progress && text.includes('Fingerprint ID');
  // The public checker renders its WebGL collector in one disclosure card:
  // heading button -> aria-controls panel -> direct label/value span rows.
  // Generic ready, guide copy and our independent canvas cannot supply it.
  const controls = [...document.querySelectorAll('[aria-controls][aria-expanded]')].filter(button =>
    [...button.querySelectorAll('[data-slot="card-title"], h2, h3, .text-lg')].some(title => title.textContent?.trim() === 'WebGL'));
  const labels = { 'Vendor:':'vendor', 'Renderer:':'renderer', 'Unmasked Vendor:':'unmaskedVendor', 'GPU:':'unmaskedRenderer' };
  const fields = {}, validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\\x00-\\x1f\\x7f]/.test(value);
  let invalid = false;
  const panel = controls.length === 1 && controls[0].getAttribute('aria-expanded') === 'true' ? document.getElementById(controls[0].getAttribute('aria-controls')) : null;
  if (panel?.isConnected) for (const row of panel.children) {
    const columns = [...row.children];
    if (columns.length !== 2 || columns.some(column => column.tagName !== 'SPAN')) continue;
    const label = columns[0].textContent?.trim();
    if (!Object.hasOwn(labels, label)) continue;
    const field = labels[label];
    if (Object.hasOwn(fields, field) || !validText(columns[1].textContent)) invalid = true;
    else fields[field] = columns[1].textContent.trim();
  }
  const fieldCount = Object.keys(fields).length;
  const coverage = controls.length === 0 ? 'missing' : controls.length !== 1 || invalid ? 'invalid' : panel?.isConnected && fieldCount === 4 ? 'complete' : 'incomplete';
  let gpu = null, independentGpuError = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      try {
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
      } finally { gl.getExtension('WEBGL_lose_context')?.loseContext?.(); }
    }
  } catch { independentGpuError = 'independent-canvas-unavailable'; }
  return { ready, error, webglVendorMismatch: ready && coverage === 'complete' ? text.includes(${JSON.stringify(MISMATCH)}) : null, gpu, independentGpuError,
    siteWebGl: fieldCount ? fields : null, siteWebGlCoverage: {state:coverage, cardCount:controls.length, fields:fieldCount},
    hasCurrentRuleChunk: performance.getEntriesByType('resource').some(e => e.name === ${JSON.stringify(CREEPJS_RULE_URL)}) };
})()`;

export async function observeCreepJs(page: PublicPageProtocol, root: string, label: string, guard: () => void) {
  guard();
  const resources = requiredResources(page, "creepjs.org");
  try {
    await page.send("Network.enable");
    const navigation = await page.send("Page.navigate", { url: CREEPJS }, 60_000);
    const error = safeNavigationError(navigation.errorText);
    if (error) return { site: "creepjs.org/checker", collection: "inconclusive", reason: error, webglVendorMismatch: null, resourceFailures: resources.failures };
    const deadline = Date.now() + 60_000;
    let state: Record<string, any> | null = null, probeError: string | null = null;
    while (Date.now() < deadline) {
      guard();
      await checkedOrigin(page, "https://creepjs.org");
      try { state = await evaluate(page, CREEPJS_STATE); }
      catch { probeError = "site-probe-failed"; break; }
      if (!state || typeof state !== "object" || typeof state.ready !== "boolean" || typeof state.error !== "boolean") { probeError = "site-probe-invalid"; break; }
      if (state.error || state.ready || resources.failures.length || resources.overflow()) break;
      await new Promise<void>(resolve => setTimeout(resolve, 500));
    }
    guard();
    await checkedOrigin(page, "https://creepjs.org");
    const rule = await verifyCurrentRule(page, resources.currentRuleRequest());
    guard();
    const capture = await screenshot(page, root, label + "-creepjs");
    const completed = !probeError && state?.ready === true && state.error === false && state.siteWebGlCoverage?.state === "complete" &&
      state.siteWebGlCoverage.cardCount === 1 && state.siteWebGlCoverage.fields === 4 && state.siteWebGl && WEBGL_FIELDS.every(field => validWebGlText(state!.siteWebGl[field])) &&
      typeof state.webglVendorMismatch === "boolean" && state.hasCurrentRuleChunk === true && rule.verified && !resources.failures.length && !resources.overflow();
    const reason = completed ? null : probeError || (resources.overflow() ? "network-observation-overflow" : resources.failures.length ? "required-resource-failed" :
      state?.error ? "site-collection-failed" : state?.ready !== true ? "site-collection-timeout" : state.siteWebGlCoverage?.state !== "complete" ? "site-webgl-coverage-unconfirmed" : rule.reason || "current-rule-not-observed");
    return {
      site: "creepjs.org/checker", collection: completed ? "completed" : "inconclusive", reason,
      webglVendorMismatch: completed && typeof state?.webglVendorMismatch === "boolean" ? state.webglVendorMismatch : null,
      siteWebGl: state?.siteWebGl ?? null, siteWebGlCoverage: state?.siteWebGlCoverage ?? { state: "unknown", cardCount: 0, fields: 0 },
      gpu: state?.gpu ?? null, independentGpuProbe: "corroboration-only; never site collector coverage", independentGpuError: state?.independentGpuError ?? null,
      ruleChunkObserved: state?.hasCurrentRuleChunk === true, ruleScriptVerified: rule.verified,
      ruleSourceSha256: CREEPJS_RULE_SHA256, ruleObservedSha256: rule.sha256, ruleVerificationReason: rule.reason,
      screenshot: capture, resourceFailures: resources.failures, networkObservationOverflow: resources.overflow(),
      wholeSiteAcceptance: "not assessed; this observation targets the reported WebGL signal",
    };
  } finally { resources.stop(); }
}

const PING0_WAIT = `(() => {
  const element = document.querySelector('#envdetect-app');
  const data = element?.__vue__?.$data;
  return { finished: data?.finished === true };
})()`;
const PING0_STATE = `(() => {
  const element = document.querySelector('#envdetect-app');
  const data = element?.__vue__?.$data;
  if (!data) return null;
  const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
  const rows = keys(data.rows);
  const rawFindings = data.finalFindings !== undefined ? data.finalFindings : data.findings;
  return { finished: data.finished, reportId: typeof data.reportId === 'string' && data.reportId.length <= 4096 ? data.reportId : null,
    score: typeof data.score === 'number' && Number.isFinite(data.score) ? data.score : null,
    rows: rows && Object.keys(rows).length <= 512 && Object.keys(rows).every(validId) ? Object.fromEntries(Object.entries(rows).map(([id, row]) => [id,
      keys(row) ? { id: row.id, pending: row.pending, fail: row.fail,
        value: id === 'dns.resolver_count' ? row.value : id === 'xc.dns_blackhole' && keys(row.value) ? { resolver_count: row.value.resolver_count } : undefined } : null])) : null,
    findings: Array.isArray(rawFindings) && rawFindings.length <= 512 ? rawFindings.map(item => keys(item) && validId(item.id) ? { id:item.id, fail:item.fail,
      ...(item.id === 'xc.dns_blackhole' ? { resolver_count:item.resolver_count, value: keys(item.value) ? { resolver_count:item.value.resolver_count } : item.value } : {}) } : null) : null };
})()`;

export async function observePing0(page: PublicPageProtocol, root: string, label: string, guard: () => void) {
  guard();
  const resources = requiredResources(page, "ping0.cc");
  try {
  await page.send("Network.enable");
  const navigation = await page.send("Page.navigate", { url: PING0 }, 60_000);
  const navigationError = safeNavigationError(navigation.errorText);
  if (navigationError) return { site: "ping0.cc/env", collection: "failed", reason: navigationError, assessment: null, resourceFailures: resources.failures };
  const deadline = Date.now() + 360_000;
  let finishedAt: string | null = null;
  while (Date.now() < deadline) {
    guard();
    await checkedOrigin(page, "https://ping0.cc");
    const probe = await evaluate(page, PING0_WAIT);
    if (probe?.finished === true && Date.now() < deadline) { finishedAt = new Date().toISOString(); break; }
    if (resources.failures.length || resources.overflow()) break;
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
  if (finishedAt !== null) {
    // Match the existing site's collector contract: only settle after an actual
    // finished flag. This is not a storage flush or a pre-close durability delay.
    const settleDeadline = Date.now() + 15_000;
    while (Date.now() < settleDeadline) {
      guard();
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(500, settleDeadline - Date.now())));
    }
  }
  guard();
  await checkedOrigin(page, "https://ping0.cc");
  const captured = await evaluate(page, PING0_STATE);
  const settledAt = new Date().toISOString();
  const completed = finishedAt !== null && captured?.finished === true && !resources.failures.length && !resources.overflow();
  const reason = completed ? null : resources.overflow() ? "network-observation-overflow" : resources.failures.length ? "required-resource-failed" : "site-collection-timeout";
  const state = captured ? { ...captured, finishedAt, settledAt } : null;
  const assessment = assessPing0Findings({ outcome: completed ? "completed" : "inconclusive", reason, state });
  const capture = await screenshot(page, root, label + "-ping0");
  return { site: "ping0.cc/env", collection: completed ? "completed" : "inconclusive", reason,
    observedFinished: captured?.finished === true, finishedAt, settledAt, reportIdPresent: typeof captured?.reportId === "string" && captured.reportId.trim().length > 0,
    score: captured?.score ?? null, assessment, screenshot: capture, resourceFailures: resources.failures, networkObservationOverflow: resources.overflow(),
    dnsTransactionsVerified: false, scope: "site findings only; no DNS-route, whole-product or visible-desktop acceptance" };
  } finally { resources.stop(); }
}
