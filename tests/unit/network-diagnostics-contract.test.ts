// Stage 3 AUTHOR-ONLY feature preparation: deliberately imports an intended new
// module. UNRUN; a missing import is not an existing-product RED. Do not execute
// before the coordinator grants the source-stable validation window.
//
// Proposed exact pure API: normalizeNetworkObservationSummary(unknown) ->
// NetworkObservationSummary | null; NETWORK_OBSERVATION_LIMITS as below.
// No config, user-data, disk writes, sockets, processes, or browser fixtures.
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import contractSource from "../../src/main/services/network-diagnostics-contract.ts?raw";

const forbidden = vi.hoisted(() => ({
  io: vi.fn(() => { throw new Error("CONTRACT_IMPORT_MUST_BE_PURE"); }),
}));
vi.mock("electron", () => ({ app: { getPath: forbidden.io }, ipcMain: { handle: forbidden.io } }));
vi.mock("node:child_process", () => ({ spawn: forbidden.io, spawnSync: forbidden.io, exec: forbidden.io, execSync: forbidden.io, execFile: forbidden.io, execFileSync: forbidden.io, fork: forbidden.io }));
vi.mock("node:fs", () => ({ readFileSync: forbidden.io, writeFileSync: forbidden.io, mkdirSync: forbidden.io, promises: { readFile: forbidden.io, writeFile: forbidden.io } }));
vi.mock("node:fs/promises", () => ({ readFile: forbidden.io, writeFile: forbidden.io, mkdir: forbidden.io }));
vi.mock("node:http", () => ({ get: forbidden.io, request: forbidden.io, createServer: forbidden.io }));
vi.mock("node:https", () => ({ get: forbidden.io, request: forbidden.io }));
vi.mock("node:dns", () => ({ lookup: forbidden.io, resolve: forbidden.io }));
vi.mock("node:dns/promises", () => ({ lookup: forbidden.io, resolve: forbidden.io }));
vi.mock("ws", () => ({ default: forbidden.io, WebSocket: forbidden.io }));
vi.mock("../../src/main/services/config-manager.js", () => { throw new Error("CONTRACT_CONFIG_IMPORT_FORBIDDEN"); });
vi.mock("../../src/main/services/browser/runtime-table.js", () => { throw new Error("CONTRACT_RUNTIME_IMPORT_FORBIDDEN"); });
vi.mock("../../src/main/services/browser/cdp-network-observer.js", () => { throw new Error("CONTRACT_TRANSPORT_IMPORT_FORBIDDEN"); });

import {
  NETWORK_OBSERVATION_LIMITS,
  normalizeNetworkObservationSummary,
  type NetworkObservationSummary,
  type NetworkCoverage,
  type NetworkCounts,
  type ObservedNetworkHop,
  type NetworkHttpStatusEvidence,
  type NetworkObservationPayload,
} from "../../src/main/services/network-diagnostics-contract.js";

const PRIVATE = "__NETWORK_SUMMARY_PRIVATE_SENTINEL__";
const AT = 1_792_387_200_000;
const COUNT_KEYS = ["requests", "hops", "responses", "finished", "failed", "blocked", "requestCancelled", "redirects", "http4xx", "http5xx", "pending", "cache", "serviceWorker", "unattributed", "cspIssues"] as const;
const COVERAGE_KEYS = ["network", "csp", "worker", "oopif", "console", "storage", "frames", "bridgeHop", "upstreamHop"] as const;
const SUMMARY_KEYS = ["version", "completion", "stopReason", "armedAt", "endedAt", "durationMs", "counts", "coverage"] as const;
const STOP_REASONS = ["window-ended", "cancelled", "deadline", "connection-closed", "target-changed", "setup-rejected", "setup-timeout", "protocol-invalid", "limit-exceeded", "evidence-incomplete", "cleanup-unverified"] as const;

function coverage(): NetworkCoverage {
  return { network: "observed", csp: "unavailable", worker: "not-observed", oopif: "not-observed", console: "not-observed", storage: "not-observed", frames: "selected-target-main-frame", bridgeHop: "unknown", upstreamHop: "unknown" };
}
function counts(): NetworkCounts {
  return { requests: 1, hops: 1, responses: 1, finished: 1, failed: 0, blocked: 0, requestCancelled: 0, redirects: 0, http4xx: 0, http5xx: 0, pending: 0, cache: 0, serviceWorker: 0, unattributed: 0, cspIssues: 0 };
}
function summary(): NetworkObservationSummary {
  return { version: 1, completion: "completed", stopReason: "window-ended", armedAt: AT, endedAt: AT + 10_000, durationMs: 10_000, counts: counts(), coverage: coverage() };
}
function unavailable(): NetworkObservationSummary {
  return { version: 1, completion: "unavailable", stopReason: "setup-rejected", armedAt: null, endedAt: AT, durationMs: 0, counts: Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) as NetworkCounts, coverage: { ...coverage(), network: "unavailable" } };
}
function invalid(value: unknown): void {
  expect(normalizeNetworkObservationSummary(value)).toBeNull();
}
function ownKeys(value: object): string[] {
  return Reflect.ownKeys(value).map(String).sort();
}

// Allocation of local constants is harmless; calling IO, a clock, an imported
// runtime, or executing an IIFE at module initialization is not. This source
// assertion complements the fail-closed import fixtures, not a bundle claim.
function pureInitializer(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node)) return pureInitializer(node.expression);
  if (ts.isLiteralExpression(node) || ts.isIdentifier(node) || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node)) return pureInitializer(node.operand);
  if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.SlashToken].includes(node.operatorToken.kind) && pureInitializer(node.left) && pureInitializer(node.right);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(element => ts.isExpression(element) && pureInitializer(element));
  if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && pureInitializer(property.initializer));
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === "Object" && node.expression.name.text === "freeze") return node.arguments.length === 1 && pureInitializer(node.arguments[0]);
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["Set", "Map"].includes(node.expression.text)) return !node.arguments || node.arguments.every(pureInitializer);
  return false;
}

describe("pure network diagnostics contract — prepared, not executed", () => {
  it("is self-contained and has no transport/runtime/secret imports or top-level effects", () => {
    const source = ts.createSourceFile("network-diagnostics-contract.ts", contractSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      expect(ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)).toBe(false);
      if (ts.isExportDeclaration(statement)) { expect(statement.moduleSpecifier).toBeUndefined(); continue; }
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
      expect(ts.isVariableStatement(statement)).toBe(true);
      if (ts.isVariableStatement(statement)) {
        expect(statement.declarationList.flags & ts.NodeFlags.Const).not.toBe(0);
        for (const declaration of statement.declarationList.declarations) {
          expect(declaration.initializer).toBeDefined();
          expect(pureInitializer(declaration.initializer!)).toBe(true);
        }
      }
    }
    const forbiddenIdentifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && ["require", "process", "fetch", "globalThis", "window", "document"].includes(node.text)) forbiddenIdentifiers.push(node.text);
      if (node.kind === ts.SyntaxKind.ImportKeyword) forbiddenIdentifiers.push("dynamic-import");
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(forbiddenIdentifiers).toEqual([]);
    expect(forbidden.io).not.toHaveBeenCalled();
  });

  it("exports the finite timing, ingress and retained-detail limits without effects", () => {
    expect(NETWORK_OBSERVATION_LIMITS).toMatchObject({
      setupMs: 5_000, observeMs: 10_000, cleanupMs: 2_000, livenessMs: 25,
      maxHops: 128, maxProjections: 256, maxDetailBytes: 256 * 1024,
      maxRawMessageBytes: 1024 * 1024, maxDiscoveryBytes: 512 * 1024,
    });
    expect(Object.isFrozen(NETWORK_OBSERVATION_LIMITS)).toBe(true);
    expect(NETWORK_OBSERVATION_LIMITS.setupMs + NETWORK_OBSERVATION_LIMITS.observeMs + NETWORK_OBSERVATION_LIMITS.cleanupMs).toBeLessThan(20_000);
  });

  it("accepts precisely the scalar coverage, typed counts and summary shape", () => {
    const input = summary();
    const result = normalizeNetworkObservationSummary(input)!;
    expect(result).toEqual(input);
    expect(ownKeys(result)).toEqual([...SUMMARY_KEYS].sort());
    expect(ownKeys(result.counts)).toEqual([...COUNT_KEYS].sort());
    expect(ownKeys(result.coverage)).toEqual([...COVERAGE_KEYS].sort());
    for (const value of Object.values(result.coverage)) expect(typeof value).toBe("string");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("exports one exact typed payload with separate browser/wire status and local association", () => {
    const hop: ObservedNetworkHop = {
      id: "hop-1", chainId: "chain-1", redirectedFrom: null, origin: "https://fixture.test:8443", method: "GET", resourceType: "Fetch",
      status: 200, networkStatus: 304, terminal: "finished", errorCode: null, blockedReason: null, corsReason: null,
      fromDiskCache: true, fromServiceWorker: false, fromPrefetchCache: null, servedFromCache: true,
    };
    const evidence: NetworkHttpStatusEvidence = { id: "evidence-1", chainId: hop.chainId, hopId: hop.id, status: 304, source: "extra-info", association: "unique" };
    const payload: NetworkObservationPayload = { observation: summary(), hops: [hop], httpStatusEvidence: [evidence] };
    expect(ownKeys(payload).sort()).toEqual(["httpStatusEvidence", "hops", "observation"].sort());
    expect(ownKeys(hop)).toEqual(["id", "chainId", "redirectedFrom", "origin", "method", "resourceType", "status", "networkStatus", "terminal", "errorCode", "blockedReason", "corsReason", "fromDiskCache", "fromServiceWorker", "fromPrefetchCache", "servedFromCache"].sort());
    expect(ownKeys(evidence)).toEqual(["id", "chainId", "hopId", "status", "source", "association"].sort());
    expect(payload.observation).not.toHaveProperty("origin");
  });

  it("returns a detached safe projection, not a writable alias of the input", () => {
    const input = summary();
    const result = normalizeNetworkObservationSummary(input)!;
    expect(result).not.toBe(input);
    expect(result.counts).not.toBe(input.counts);
    expect(result.coverage).not.toBe(input.coverage);
    input.counts.requests = 88; input.coverage.network = "partial";
    expect(result.counts.requests).toBe(1);
    expect(result.coverage.network).toBe("observed");
  });

  it("accepts own JSON-like fields on null-prototype records without borrowing inherited defaults", () => {
    const input = Object.assign(Object.create(null), summary());
    input.counts = Object.assign(Object.create(null), counts());
    input.coverage = Object.assign(Object.create(null), coverage());
    expect(normalizeNetworkObservationSummary(input)).toEqual(summary());
  });

  it.each([undefined, null, true, false, 0, 1, "", PRIVATE, [], [summary()], new Date(AT), new Map(), new Set()].map(input => ({ input })))("rejects non-record summary input %#", ({ input }) => invalid(input));

  it.each(SUMMARY_KEYS)("does not invent missing summary.%s", key => {
    const input: Record<string, unknown> = { ...summary() }; delete input[key]; invalid(input);
  });
  it.each(COUNT_KEYS)("does not invent missing counts.%s", key => {
    const input = summary(); delete (input.counts as unknown as Record<string, unknown>)[key]; invalid(input);
  });
  it.each(COVERAGE_KEYS)("does not invent missing coverage.%s", key => {
    const input = summary(); delete (input.coverage as unknown as Record<string, unknown>)[key]; invalid(input);
  });

  it.each(["origin", "origins", "hops", "httpStatusEvidence", "url", "title", "error", "headers", "body", "message", "stack", "stderr", "outcome", "pass", "websiteHealthy", "proxyHealthy", "__proto__", "constructor"])("rejects an extra summary field %s rather than persisting unsafe strings or PASS", key => {
    const input = summary();
    Object.defineProperty(input, key, { value: PRIVATE, enumerable: true, configurable: true });
    invalid(input);
  });

  it.each(["counts", "coverage"] as const)("rejects unknown, symbol and hidden fields in %s", key => {
    for (const extra of ["raw", "unsafe", Symbol(PRIVATE)]) {
      const input = summary(); Object.defineProperty(input[key], extra, { value: PRIVATE, enumerable: true }); invalid(input);
    }
    const hidden = summary(); Object.defineProperty(hidden[key], "hidden", { value: PRIVATE, enumerable: false }); invalid(hidden);
  });

  it("rejects symbol/hidden summary fields, custom prototypes and inherited required fields", () => {
    const symbol = summary(); Object.defineProperty(symbol, Symbol(PRIVATE), { value: PRIVATE }); invalid(symbol);
    const hidden = summary(); Object.defineProperty(hidden, "hidden", { value: PRIVATE }); invalid(hidden);
    invalid(Object.assign(Object.create({ unexpected: PRIVATE }), summary()));
    invalid(Object.create(summary()));
    const inherited = summary(); inherited.counts = Object.create(counts()); invalid(inherited);
    const inheritedCoverage = summary(); inheritedCoverage.coverage = Object.create(coverage()); invalid(inheritedCoverage);
    class Custom { value = PRIVATE; }
    invalid(Object.assign(new Custom(), summary()));
  });

  it.each(["root", "counts", "coverage"] as const)("rejects accessor fields without invoking a %s getter", section => {
    const input = summary(); const getter = vi.fn(() => { throw new Error(PRIVATE); });
    const record = section === "root" ? input : input[section];
    const key = section === "root" ? "version" : section === "counts" ? "requests" : "network";
    Object.defineProperty(record, key, { get: getter, enumerable: true });
    invalid(input); expect(getter).not.toHaveBeenCalled();
  });

  it("does not leak a hostile proxy trap as a protocol/storage exception", () => {
    const input = new Proxy({}, { ownKeys: () => { throw new Error(PRIVATE); }, getPrototypeOf: () => { throw new Error(PRIVATE); } });
    expect(() => invalid(input)).not.toThrow();
  });

  it.each([0, 2, "1", null, true, NaN, Infinity])("rejects invalid version %#", version => invalid({ ...summary(), version }));
  it.each(["PASS", "success", "healthy", "", PRIVATE, null, 1, {}, []].map(completion => ({ completion })))("rejects unknown completion %#", ({ completion }) => invalid({ ...summary(), completion }));
  it.each(["PASS", "proxy-auth-failed", "ERR_PROXY_CONNECTION_FAILED", PRIVATE, "", null, 1, {}, []].map(stopReason => ({ stopReason })))("rejects raw or unknown stop reason %#", ({ stopReason }) => invalid({ ...summary(), stopReason }));

  it("admits only the documented static stop reasons, not appended native messages", () => {
    for (const stopReason of STOP_REASONS) {
      const input = stopReason === "setup-rejected" || stopReason === "setup-timeout" ? unavailable() : summary();
      input.stopReason = stopReason;
      input.completion = stopReason === "window-ended" ? "completed" : stopReason === "cancelled" ? "cancelled" : input.armedAt === null ? "unavailable" : "partial";
      if (input.completion !== "completed" && input.armedAt !== null) input.coverage.network = "partial";
      expect(normalizeNetworkObservationSummary(input)).toEqual(input);
      invalid({ ...input, stopReason: `${stopReason}: ${PRIVATE}` });
    }
  });

  it.each([undefined, null, "", [], PRIVATE, false].map(value => ({ value })))("rejects invalid counts/coverage containers %#", ({ value }) => {
    invalid({ ...summary(), counts: value }); invalid({ ...summary(), coverage: value });
  });

  it.each(COUNT_KEYS)("rejects invalid numeric counts.%s without coercion", key => {
    for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, true, {}, []]) {
      const input = summary(); (input.counts as unknown as Record<string, unknown>)[key] = value; invalid(input);
    }
  });

  it("enforces hop inventory, disjoint terminals and known-hop response bounds", () => {
    for (const change of [
      { requests: 2 }, { hops: 2 }, { responses: 2 }, { finished: 0 }, { failed: 1 }, { blocked: 1 }, { requestCancelled: 1 }, { redirects: 1 }, { pending: 1 },
      { cache: 2 }, { serviceWorker: 2 }, { http4xx: 2 }, { http5xx: 2 },
    ]) invalid({ ...summary(), counts: { ...counts(), ...change } });
    const noResponse = summary(); noResponse.counts = { ...counts(), responses: 0, http4xx: 1 }; invalid(noResponse);
    const tooManyHops = summary(); tooManyHops.counts = { ...counts(), requests: 129, hops: 129, responses: 129, finished: 129 }; invalid(tooManyHops);
    invalid({ ...summary(), counts: { ...counts(), unattributed: 257 } });
    invalid({ ...summary(), counts: { ...counts(), cspIssues: 257 }, coverage: { ...coverage(), csp: "observed" } });
  });

  it("allows known HTTP failures in a completed observation; completion is not site/proxy success", () => {
    const input = summary(); input.counts = { ...counts(), finished: 0, failed: 1, http4xx: 1 };
    expect(normalizeNetworkObservationSummary(input)).toEqual(input);
    expect(ownKeys(normalizeNetworkObservationSummary(input)!)).toEqual([...SUMMARY_KEYS].sort());
    const cancelledRequest = summary(); cancelledRequest.counts = { ...counts(), finished: 0, requestCancelled: 1 };
    expect(normalizeNetworkObservationSummary(cancelledRequest)).toEqual(cancelledRequest);
  });

  it("keeps unknown-hop status evidence separate instead of inferring a known-hop HTTP response", () => {
    const input = summary(); input.completion = "partial"; input.stopReason = "evidence-incomplete";
    input.coverage.network = "partial";
    input.counts = { ...counts(), responses: 0, finished: 0, failed: 1, unattributed: 1 };
    expect(normalizeNetworkObservationSummary(input)).toEqual(input);
    invalid({ ...input, counts: { ...input.counts, http4xx: 1 } });
  });

  it.each(COVERAGE_KEYS)("rejects nested and unsupported coverage.%s claims", key => {
    for (const value of [{ observed: true }, { status: "observed", sample: PRIVATE }, [], true, 1, null, "all", "PASS", PRIVATE]) {
      const input = summary(); (input.coverage as unknown as Record<string, unknown>)[key] = value; invalid(input);
    }
  });
  it.each(["worker", "oopif", "console", "storage"] as const)("never upgrades %s to observed", key => invalid({ ...summary(), coverage: { ...coverage(), [key]: "observed" } }));
  it.each(["bridgeHop", "upstreamHop"] as const)("never makes an unsupported %s attribution", key => invalid({ ...summary(), coverage: { ...coverage(), [key]: "failed" } }));
  it.each(["all-frames", "selected-target", "same-origin", "all-targets", "main-frame"])("rejects unapproved frame scope %s", frames => invalid({ ...summary(), coverage: { ...coverage(), frames } }));

  it("requires CSP evidence to have an acknowledged CSP coverage claim", () => {
    invalid({ ...summary(), counts: { ...counts(), cspIssues: 1 } });
    const observed = summary(); observed.coverage.csp = "observed"; observed.counts.cspIssues = 1;
    expect(normalizeNetworkObservationSummary(observed)).toEqual(observed);
  });

  it.each(["armedAt", "endedAt", "durationMs"] as const)("rejects non-finite, unsafe, negative and non-integer %s", key => {
    for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "10000", true, {}, []]) invalid({ ...summary(), [key]: value });
  });
  it("does not invent timestamps or accept impossible observation durations", () => {
    invalid({ ...summary(), armedAt: undefined }); invalid({ ...summary(), endedAt: null }); invalid({ ...summary(), durationMs: null });
    invalid({ ...summary(), endedAt: AT - 1 });
    invalid({ ...summary(), durationMs: 9_999 });
    invalid({ ...summary(), endedAt: AT + 10_001, durationMs: 10_001 });
    invalid({ ...summary(), completion: "completed", armedAt: null, durationMs: 0 });
    invalid({ ...summary(), completion: "completed", stopReason: "connection-closed" });
    invalid({ ...summary(), completion: "completed", endedAt: AT + 9_999, durationMs: 9_999 });
  });
  it("keeps pre-arm unavailability distinct from an actual observation", () => {
    const input = unavailable(); expect(normalizeNetworkObservationSummary(input)).toEqual(input);
    invalid({ ...input, durationMs: 1 });
    invalid({ ...input, armedAt: AT - 1, durationMs: 1 });
    invalid({ ...input, coverage: { ...input.coverage, network: "observed" } });
    invalid({ ...input, coverage: { ...input.coverage, csp: "observed" } });
    invalid({ ...input, counts: counts() });
  });

  it("cannot turn a quiet window, cancellation or pending work into a persisted PASS", () => {
    const quiet = summary(); quiet.counts = unavailable().counts;
    expect(normalizeNetworkObservationSummary(quiet)).toEqual(quiet);
    const pending = summary(); pending.completion = "partial"; pending.stopReason = "evidence-incomplete";
    pending.coverage.network = "partial"; pending.counts = { ...counts(), responses: 0, finished: 0, pending: 1 };
    expect(normalizeNetworkObservationSummary(pending)).toEqual(pending);
    const cancelled = { ...pending, completion: "cancelled" as const, stopReason: "cancelled" as const };
    expect(normalizeNetworkObservationSummary(cancelled)).toEqual(cancelled);
    for (const input of [quiet, pending, cancelled, unavailable()]) {
      for (const key of ["outcome", "health", "pass", "website", "proxy"]) invalid({ ...input, [key]: "PASS" });
    }
    expect(forbidden.io).not.toHaveBeenCalled();
  });
});
