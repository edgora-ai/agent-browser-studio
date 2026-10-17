import { describe, expect, it } from "vitest";
import type { BrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import {
  FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION,
  FINGERPRINT_FIELD_INVENTORY,
  FINGERPRINT_PROBE_MANIFEST_VERSION,
  aggregateFingerprintAcceptance,
  createFingerprintProbeManifest,
  type AcceptanceSummary,
  type EvidenceBinding,
  type EvidenceReference,
  type ProbeCheck,
  type ProbeLane,
  type ProbeManifest,
  type ProbeResult,
  type ProbeSpec,
} from "../../src/tools/fingerprint-acceptance.js";

// All observations, hashes and artifact names below are synthetic in-memory
// fixtures. These tests verify the ledger, not a browser or artifact authenticity.
const LANE: ProbeLane = { hostPlatform: "darwin", engine: "chromium", mode: "headed", identityMode: "managed" };
const TARGET = "identity.navigator";
const HASH = (digit: string): string => digit.repeat(64);

function fixture(lane: ProbeLane = LANE) {
  const manifest = createFingerprintProbeManifest(lane);
  const binding: EvidenceBinding = {
    ...lane,
    schemaVersion: FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION,
    manifestVersion: FINGERPRINT_PROBE_MANIFEST_VERSION,
    sourceRevision: "synthetic-source-revision",
    sourceDirty: true,
    sourceSha256: HASH("1"),
    binarySha256: HASH("2"),
    configSha256: HASH("3"),
    runId: "synthetic-run-1",
    hostId: "synthetic-owned-host",
    profileId: "synthetic-owned-profile",
  };
  const results: ProbeResult[] = manifest.probes.map((spec) => {
    if (spec.support.status === "UNSUPPORTED") return { id: spec.id, status: "UNSUPPORTED" };
    const evidence: EvidenceReference[] = spec.contexts.map((context) => ({
      id: `${spec.id}:${context}:evidence`, probeId: spec.id, kind: spec.evidenceKind, context,
      artifact: `synthetic-not-a-file/${spec.id}.json`, locator: `/observations/${context}`,
      sha256: HASH("4"), binding: { ...binding },
    }));
    const checks: ProbeCheck[] = spec.contexts.map((context, index) => ({
      id: `${spec.id}:${context}:assertion`, context, passed: true,
      expected: { syntheticObservation: context }, actual: { syntheticObservation: context },
      evidenceIds: [evidence[index]!.id],
    }));
    return { id: spec.id, status: "PASS", checks, evidence };
  });
  return { manifest, binding, results };
}
type Fixture = ReturnType<typeof fixture>;
function findResult(f: Fixture, id = TARGET): ProbeResult {
  const result = f.results.find((row) => row.id === id);
  if (!result) throw new Error(`Missing synthetic result ${id}`);
  return result;
}
function row(summary: AcceptanceSummary, id = TARGET) {
  const result = summary.results.find((item) => item.id === id);
  if (!result) throw new Error(`Missing ledger row ${id}`);
  return result;
}
function summarize(f: Fixture, result: ProbeResult, id = TARGET): AcceptanceSummary {
  return aggregateFingerprintAcceptance(f.manifest, f.binding, f.results.map((item) => item.id === id ? result : item));
}
function withReference(result: ProbeResult, change: (ref: EvidenceReference) => EvidenceReference): ProbeResult {
  return { ...result, evidence: result.evidence!.map((ref, index) => index === 0 ? change(ref) : ref) };
}
function withCheck(result: ProbeResult, change: (check: ProbeCheck) => ProbeCheck): ProbeResult {
  return { ...result, checks: result.checks!.map((check, index) => index === 0 ? change(check) : check) };
}
function expectFailed(f: Fixture, result: ProbeResult, id = TARGET): AcceptanceSummary {
  const summary = summarize(f, result, id);
  expect(summary.eligible).toBe(false);
  expect(row(summary, id).status).toBe("FAIL");
  expect(summary.totals.required).toBe(f.manifest.probes.filter((spec) => spec.required && spec.support.status === "SUPPORTED").length);
  return summary;
}

const CONFIG_FIELDS = [
  "schemaVersion", "seed", "platform", "platformVersion", "userAgent", "appVersion", "vendor", "languages",
  "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "hardwareProfile", "screen", "storageQuotaBytes",
  "canvas", "audio", "webgl", "webgpu", "webauthn", "speechSynthesis", "webrtc", "timezone", "geolocation",
  "mediaDevices", "secureDns", "fonts", "doNotTrack", "pluginProfile",
] as const satisfies readonly (keyof BrowserFingerprintConfig)[];

describe("static fingerprint acceptance manifest", () => {
  it("inventories every declared config field and points to real probe declarations", () => {
    const manifest = createFingerprintProbeManifest(LANE);
    expect(Object.keys(FINGERPRINT_FIELD_INVENTORY).sort()).toEqual([...CONFIG_FIELDS].sort());
    for (const [field, coverage] of Object.entries(FINGERPRINT_FIELD_INVENTORY)) {
      expect(coverage.reason.trim().length).toBeGreaterThan(0);
      expect(coverage.probes.length).toBeGreaterThan(0);
      for (const id of coverage.probes) {
        const spec = manifest.probes.find((item) => item.id === id);
        expect(spec?.configFields).toContain(field);
      }
    }
    expect(FINGERPRINT_FIELD_INVENTORY.schemaVersion.kind).toBe("parameter");
    expect(FINGERPRINT_FIELD_INVENTORY.seed.kind).toBe("parameter");
    expect(FINGERPRINT_FIELD_INVENTORY.hardwareProfile.kind).toBe("provenance");
  });

  it("freezes support, denominator, contexts and lane before any results exist", () => {
    const lane = { ...LANE };
    const manifest = createFingerprintProbeManifest(lane);
    lane.mode = "headless";
    expect(manifest.lane.mode).toBe("headed");
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.lane)).toBe(true);
    expect(Object.isFrozen(manifest.probes)).toBe(true);
    expect(new Set(manifest.probes.map((spec) => spec.id)).size).toBe(manifest.probes.length);
    for (const spec of manifest.probes) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.contexts)).toBe(true);
      expect(Object.isFrozen(spec.support)).toBe(true);
      expect(spec.contexts.length).toBeGreaterThan(0);
      expect(spec.contract.trim().length).toBeGreaterThan(0);
      if (spec.support.status === "SUPPORTED") expect(spec.required).toBe(true);
    }
  });

  it.each([
    ["support.foreign-platform", "launch.reject-foreign-platform"],
    ["support.android", "launch.reject-android"],
    ["support.gpu-override", "launch.reject-gpu-override"],
    ["support.native-strict-doh", "launch.reject-native-strict-doh"],
  ])("keeps %s visible and its rejection probe required", (unsupportedId, rejectionId) => {
    const f = fixture();
    const summary = aggregateFingerprintAcceptance(f.manifest, f.binding, []);
    expect(row(summary, unsupportedId).status).toBe("UNSUPPORTED");
    expect(row(summary, unsupportedId).reason).toBeTruthy();
    expect(row(summary, rejectionId).status).toBe("NOTRUN");
    expect(row(summary, rejectionId).required).toBe(true);
    expect(summary.eligible).toBe(false);
  });

  it("keeps Firefox independent without importing Chromium unsupported launch permutations", () => {
    const f = fixture({ ...LANE, engine: "firefox" });
    const summary = aggregateFingerprintAcceptance(f.manifest, f.binding, []);
    expect(row(summary, "identity.ua-ch").status).toBe("UNSUPPORTED");
    expect(row(summary, "identity.http").status).toBe("NOTRUN");
    expect(row(summary, "gpu.webgl").status).toBe("NOTRUN");
    expect(summary.results.some((item) => item.id === "launch.reject-gpu-override")).toBe(false);
    expect(summary.eligible).toBe(false);
  });

  it.each([
    { ...LANE, hostPlatform: "linux" },
    { ...LANE, hostPlatform: "android" },
    { ...LANE, engine: "webkit" },
    { ...LANE, mode: "unknown" },
    { ...LANE, identityMode: "unknown" },
    null,
  ])("rejects an undeclared lane %j", (lane) => {
    expect(() => createFingerprintProbeManifest(lane as unknown as ProbeLane)).toThrow(/lane/);
  });
});

describe("fixed result denominator and named totals", () => {
  it("derives eligibility from all required evidenced checks, not a caller pass flag", () => {
    const f = fixture();
    const summary = aggregateFingerprintAcceptance(f.manifest, f.binding, f.results);
    expect(summary.eligible).toBe(true);
    expect(summary.totals.required).toBeGreaterThan(0);
    expect(summary.totals.requiredPassed).toBe(summary.totals.required);
    expect(summary.totals.PASS).toBe(summary.totals.required);
    expect(summary.totals.UNSUPPORTED).toBe(4);
    expect(summary.totals.FAIL + summary.totals.BLOCKED + summary.totals.NOTRUN).toBe(0);
    expect(summary.totals.total).toBe(f.manifest.probes.length);
    expect(summary.results.every((item) => item.id && item.name)).toBe(true);
    expect(summary.binding).toEqual(f.binding);
    expect(summary.manifestVersion).toBe(FINGERPRINT_PROBE_MANIFEST_VERSION);
    expect(summary.schemaVersion).toBe(FINGERPRINT_ACCEPTANCE_SCHEMA_VERSION);
  });

  it("turns every missing supported result into NOTRUN, never a vacuous pass", () => {
    const f = fixture();
    const summary = aggregateFingerprintAcceptance(f.manifest, f.binding, []);
    expect(summary.eligible).toBe(false);
    expect(summary.totals.PASS).toBe(0);
    expect(summary.totals.requiredPassed).toBe(0);
    expect(summary.totals.NOTRUN).toBe(summary.totals.required);
    expect(summary.results).toHaveLength(f.manifest.probes.length);
    expect(summary.results.filter((item) => item.support.status === "SUPPORTED").every((item) => item.status === "NOTRUN")).toBe(true);
  });

  it("retains one omitted row and the entire denominator among otherwise valid rows", () => {
    const f = fixture();
    const summary = aggregateFingerprintAcceptance(f.manifest, f.binding, f.results.filter((item) => item.id !== TARGET));
    expect(row(summary).status).toBe("NOTRUN");
    expect(summary.totals.NOTRUN).toBe(1);
    expect(summary.totals.requiredPassed).toBe(summary.totals.required - 1);
    expect(summary.eligible).toBe(false);
  });

  it.each(["FAIL", "BLOCKED", "NOTRUN"] as const)("does not count a known %s result as PASS", (status) => {
    const f = fixture();
    const result: ProbeResult = status === "BLOCKED" ? blockedResult(f) : { id: TARGET, status, reason: "Synthetic probe not successful" };
    const summary = summarize(f, result);
    expect(row(summary).status).toBe(status);
    expect(summary.totals[status]).toBe(1);
    expect(summary.totals.PASS).toBe(summary.totals.required - 1);
    expect(summary.eligible).toBe(false);
  });

  it("rejects unknown IDs instead of silently dropping them", () => {
    const f = fixture();
    expect(() => aggregateFingerprintAcceptance(f.manifest, f.binding, [...f.results, { id: "invented.probe", status: "PASS" }])).toThrow(/Unknown/);
  });

  it.each([TARGET, "support.android"])("rejects duplicate result ID %s", (id) => {
    const f = fixture();
    expect(() => aggregateFingerprintAcceptance(f.manifest, f.binding, [...f.results, findResult(f, id)])).toThrow(/Duplicate/);
  });

  it.each([null, {}, { id: "" }, { id: 9 }])("rejects malformed result ID %j", (result) => {
    const f = fixture();
    expect(() => aggregateFingerprintAcceptance(f.manifest, f.binding, [result as unknown as ProbeResult])).toThrow(/ID/);
  });

  it("does not let a required supported probe become UNSUPPORTED", () => {
    const f = fixture();
    const summary = expectFailed(f, { id: TARGET, status: "UNSUPPORTED", reason: "Collector not written" });
    expect(row(summary).required).toBe(true);
    expect(row(summary).support.status).toBe("SUPPORTED");
    expect(summary.totals.UNSUPPORTED).toBe(4);
  });

  it("does not let a predeclared unsupported row claim execution success", () => {
    const f = fixture();
    expectFailed(f, { id: "support.android", status: "PASS" }, "support.android");
  });

  it("does not accept a new unsupported reason inferred from failure", () => {
    const f = fixture();
    expectFailed(f, { id: "support.android", status: "UNSUPPORTED", reason: "Probe failed so unsupported" }, "support.android");
  });

  it.each(["pass", "SKIP", "TIMEOUT", "", null, 1])("keeps invalid status %j as a named FAIL", (status) => {
    const f = fixture();
    expectFailed(f, { ...findResult(f), status } as unknown as ProbeResult);
  });

  it.each(["PASS", "FAIL", "BLOCKED", "NOTRUN", "UNSUPPORTED"] as const)("treats a %s timeout as FAIL", (status) => {
    const f = fixture();
    const summary = expectFailed(f, { id: TARGET, status, timedOut: true });
    expect(row(summary).timedOut).toBe(true);
    expect(row(summary).reason).toMatch(/timed out/);
  });

  it("rejects a malformed timeout flag", () => {
    const f = fixture();
    expectFailed(f, { ...findResult(f), timedOut: "false" } as unknown as ProbeResult);
  });
});

describe("PASS requires named checks and concrete context evidence", () => {
  const malformedCases: readonly [string, (result: ProbeResult) => ProbeResult][] = [
    ["no evidence", (r) => ({ ...r, evidence: [] })],
    ["no checks", (r) => ({ ...r, checks: [] })],
    ["omitted evidence", (r) => ({ ...r, evidence: undefined })],
    ["omitted checks", (r) => ({ ...r, checks: undefined })],
    ["nonarray evidence", (r) => ({ ...r, evidence: {} } as unknown as ProbeResult)],
    ["nonarray checks", (r) => ({ ...r, checks: {} } as unknown as ProbeResult)],
    ["missing required context", (r) => ({ ...r, checks: r.checks!.slice(1) })],
    ["missing required context evidence", (r) => ({ ...r, evidence: r.evidence!.slice(1) })],
    ["blank artifact", (r) => withReference(r, (ref) => ({ ...ref, artifact: " " }))],
    ["blank locator", (r) => withReference(r, (ref) => ({ ...ref, locator: "" }))],
    ["invalid artifact digest", (r) => withReference(r, (ref) => ({ ...ref, sha256: "not-a-hash" }))],
    ["wrong probe", (r) => withReference(r, (ref) => ({ ...ref, probeId: "runtime.version" }))],
    ["wrong evidence context", (r) => withReference(r, (ref) => ({ ...ref, context: "dns" }))],
    ["wrong evidence kind", (r) => withReference(r, (ref) => ({ ...ref, kind: "prerequisite" }))],
    ["duplicate evidence ID", (r) => ({ ...r, evidence: [...r.evidence!, r.evidence![0]!] })],
    ["duplicate check ID", (r) => ({ ...r, checks: [...r.checks!, r.checks![0]!] })],
    ["blank check ID", (r) => withCheck(r, (check) => ({ ...check, id: " " }))],
    ["failed check", (r) => withCheck(r, (check) => ({ ...check, passed: false, reason: "Actual mismatch" }))],
    ["invalid check outcome", (r) => withCheck(r, (check) => ({ ...check, passed: "true" } as unknown as ProbeCheck))],
    ["undefined actual", (r) => withCheck(r, (check) => ({ ...check, actual: undefined } as unknown as ProbeCheck))],
    ["undefined expected", (r) => withCheck(r, (check) => ({ ...check, expected: undefined } as unknown as ProbeCheck))],
    ["nonfinite actual", (r) => withCheck(r, (check) => ({ ...check, actual: Number.NaN }))],
    ["function actual", (r) => withCheck(r, (check) => ({ ...check, actual: () => true } as unknown as ProbeCheck))],
    ["missing check evidence IDs", (r) => withCheck(r, (check) => ({ ...check, evidenceIds: [] }))],
    ["unknown check evidence ID", (r) => withCheck(r, (check) => ({ ...check, evidenceIds: ["not-recorded"] }))],
    ["duplicate check evidence ID", (r) => withCheck(r, (check) => ({ ...check, evidenceIds: [check.evidenceIds[0]!, check.evidenceIds[0]!] }))],
    ["cross-context evidence ID", (r) => withCheck(r, (check) => ({ ...check, evidenceIds: [r.evidence![1]!.id] }))],
    ["wrong check context", (r) => withCheck(r, (check) => ({ ...check, context: "dns" }))],
    ["failure reason on passed check", (r) => withCheck(r, (check) => ({ ...check, reason: "Mismatch" }))],
    ["failure reason on PASS", (r) => ({ ...r, reason: "Mismatch" })],
    ["empty reason on PASS", (r) => ({ ...r, reason: "" })],
    ["blocker on PASS", (r) => ({ ...r, blocker: { prerequisite: "No permission", evidenceIds: [] } })],
  ];
  it.each(malformedCases)("rejects %s without reducing the denominator", (_name, change) => {
    const f = fixture();
    expectFailed(f, change(findResult(f)));
  });

  it("rejects cyclic observation data without initializing production or a filesystem", () => {
    const f = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = withCheck(findResult(f), (check) => ({ ...check, actual: cyclic } as unknown as ProbeCheck));
    expectFailed(f, result);
  });

  it("requires the actual full-validator receipt kind, not a generic capture-only core pass", () => {
    const f = fixture();
    const id = "identity.full-validator";
    const result = findResult(f, id);
    expect(f.manifest.probes.find((spec) => spec.id === id)?.evidenceKind).toBe("full-identity-assertions");
    expectFailed(f, { ...result, evidence: result.evidence!.map((ref) => ({ ...ref, kind: "capture" })) }, id);
  });

  it("can record an explicit omission shape without creating nonexistent UA-CH value checks", () => {
    const f = fixture();
    const id = "identity.full-validator";
    const original = findResult(f, id);
    const checks = original.checks!.map((check) => check.context === "http-dedicated-worker" ? {
      ...check, id: "native-matched-complete-worker-hint-omission-shape",
      expected: { requestSucceeded: true, uaCorrect: true, completeHintOmission: true },
      actual: { requestSucceeded: true, uaCorrect: true, completeHintOmission: true, absentValueObservations: ["model", "wow64", "fullVersionList"] },
    } : check);
    const summary = summarize(f, { ...original, checks }, id);
    expect(summary.eligible).toBe(true);
    const omission = row(summary, id).checks.find((check) => check.context === "http-dedicated-worker")!;
    expect(omission.id).toMatch(/omission-shape/);
    expect(omission.actual).toMatchObject({ absentValueObservations: ["model", "wow64", "fullVersionList"] });
    expect(row(summary, id).checks.some((check) => check.id === "missing-model-value-pass")).toBe(false);
  });
});

describe("evidence identity, dirty source and profile/software provenance", () => {
  const mismatches: readonly [keyof EvidenceBinding, unknown][] = [
    ["schemaVersion", 0], ["manifestVersion", "fingerprint-acceptance/old"],
    ["sourceRevision", "another-source-revision"], ["sourceDirty", false], ["sourceSha256", HASH("a")],
    ["binarySha256", HASH("b")], ["configSha256", HASH("c")], ["runId", "previous-run"],
    ["hostId", "another-owned-host"], ["profileId", "another-owned-profile"],
    ["hostPlatform", "win32"], ["engine", "firefox"], ["mode", "headless"], ["identityMode", "native"],
  ];
  it.each(mismatches)("rejects stale or mixed %s even with a PASS status", (key, value) => {
    const f = fixture();
    const result = withReference(findResult(f), (ref) => ({ ...ref, binding: { ...ref.binding, [key]: value } as EvidenceBinding }));
    expectFailed(f, result);
  });

  it.each(["sourceSha256", "binarySha256", "configSha256", "sourceDirty", "profileId", "hostId", "runId"] as const)("rejects missing summary binding %s", (key) => {
    const f = fixture();
    const binding = { ...f.binding, [key]: undefined } as unknown as EvidenceBinding;
    expect(() => aggregateFingerprintAcceptance(f.manifest, binding, f.results)).toThrow(/binding/);
  });

  it("does not accept a git-commit-only receipt for dirty source", () => {
    const f = fixture();
    const { sourceSha256: _discarded, ...gitOnly } = f.binding;
    expect(() => aggregateFingerprintAcceptance(f.manifest, gitOnly as EvidenceBinding, f.results)).toThrow(/sourceSha256/);
    const sameCommitDifferentDirtySource = withReference(findResult(f), (ref) => ({ ...ref, binding: { ...ref.binding, sourceSha256: HASH("e") } }));
    expectFailed(f, sameCommitDifferentDirtySource);
  });

  it.each([
    { ...LANE, hostPlatform: "win32" as const },
    { ...LANE, engine: "firefox" as const },
    { ...LANE, mode: "headless" as const },
    { ...LANE, identityMode: "native" as const },
  ])("does not lend Mac Chromium headed managed evidence to lane %j", (lane) => {
    const mac = fixture();
    const external = fixture(lane);
    expectFailed(external, findResult(mac));
    expect(() => aggregateFingerprintAcceptance(external.manifest, mac.binding, [])).toThrow(/lane mismatch/);
  });

  it("returns frozen snapshots rather than a mutable view of submitted provenance", () => {
    const f = fixture();
    const summary = aggregateFingerprintAcceptance(f.manifest, f.binding, f.results);
    const original = findResult(f);
    (f.binding as { runId: string }).runId = "changed-after-summary";
    (original.evidence![0]!.binding as { binarySha256: string }).binarySha256 = HASH("f");
    (original.checks![0]!.actual as { syntheticObservation: string }).syntheticObservation = "changed";
    expect(summary.binding.runId).toBe("synthetic-run-1");
    expect(row(summary).evidence[0]!.binding.binarySha256).toBe(HASH("2"));
    expect(row(summary).checks[0]!.actual).toEqual({ syntheticObservation: "window" });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.binding)).toBe(true);
    expect(Object.isFrozen(summary.results)).toBe(true);
    expect(Object.isFrozen(row(summary).checks[0]!.actual)).toBe(true);
    expect(Object.isFrozen(summary.totals)).toBe(true);
  });
});

function blockedResult(f: Fixture): ProbeResult {
  const evidence: EvidenceReference = {
    id: "synthetic-prerequisite-evidence", probeId: TARGET, kind: "prerequisite", context: "prerequisite",
    artifact: "synthetic-not-a-file/prerequisite.json", locator: "/permission", sha256: HASH("5"), binding: { ...f.binding },
  };
  return {
    id: TARGET, status: "BLOCKED", reason: "Required owned-origin permission is unavailable",
    blocker: { prerequisite: "Owned-origin permission", evidenceIds: [evidence.id] }, evidence: [evidence],
  };
}

describe("BLOCKED is an evidenced prerequisite, not a disguised failure", () => {
  it("preserves prerequisite reason/evidence while keeping the required row in the denominator", () => {
    const f = fixture();
    const summary = summarize(f, blockedResult(f));
    expect(summary.eligible).toBe(false);
    expect(row(summary).status).toBe("BLOCKED");
    expect(row(summary).blocker?.prerequisite).toBe("Owned-origin permission");
    expect(row(summary).evidence[0]!.context).toBe("prerequisite");
    expect(summary.totals.BLOCKED).toBe(1);
    expect(summary.totals.requiredPassed).toBe(summary.totals.required - 1);
  });

  const invalidBlocks: readonly [string, (result: ProbeResult) => ProbeResult][] = [
    ["missing prerequisite", (r) => ({ ...r, blocker: undefined })],
    ["missing reason", (r) => ({ ...r, reason: undefined })],
    ["blank prerequisite", (r) => ({ ...r, blocker: { prerequisite: " ", evidenceIds: r.blocker!.evidenceIds } })],
    ["no prerequisite evidence", (r) => ({ ...r, evidence: [] })],
    ["no prerequisite evidence IDs", (r) => ({ ...r, blocker: { ...r.blocker!, evidenceIds: [] } })],
    ["wrong prerequisite kind", (r) => withReference(r, (ref) => ({ ...ref, kind: "capture" }))],
    ["ordinary context", (r) => withReference(r, (ref) => ({ ...ref, context: "window", kind: "capture" }))],
    ["timeout", (r) => ({ ...r, timedOut: true })],
  ];
  it.each(invalidBlocks)("makes BLOCKED with %s fail", (_name, change) => {
    const f = fixture();
    expectFailed(f, change(blockedResult(f)));
  });

  it("does not hide a failed assertion behind an external prerequisite", () => {
    const f = fixture();
    const passed = findResult(f);
    const blocked = blockedResult(f);
    const result: ProbeResult = {
      ...blocked, evidence: [...blocked.evidence!, ...passed.evidence!],
      checks: passed.checks!.map((check, index) => index === 0 ? { ...check, passed: false, reason: "Measured mismatch" } : check),
    };
    const summary = expectFailed(f, result);
    expect(row(summary).reason).toBe("Measured mismatch");
  });

  it("does not let NOTRUN carry completed successful checks", () => {
    const f = fixture();
    expectFailed(f, { ...findResult(f), status: "NOTRUN" });
  });
});

type MutableManifest = { schemaVersion: number; manifestVersion: string; lane: ProbeLane; probes: ProbeSpec[] };
function alteredManifest(original: ProbeManifest, change: (manifest: MutableManifest) => void): ProbeManifest {
  const copy: MutableManifest = { ...original, lane: { ...original.lane }, probes: [...original.probes] };
  change(copy);
  return copy as ProbeManifest;
}

describe("invalid or post-hoc manifests cannot shrink the gate", () => {
  const changes: readonly [string, (manifest: MutableManifest) => void][] = [
    ["old schema", (m) => { m.schemaVersion = 0; }],
    ["old manifest version", (m) => { m.manifestVersion = "fingerprint-acceptance/old"; }],
    ["empty set", (m) => { m.probes = []; }],
    ["unsupported-only set", (m) => { m.probes = m.probes.filter((spec) => spec.support.status === "UNSUPPORTED"); }],
    ["missing supported row", (m) => { m.probes = m.probes.slice(1); }],
    ["duplicate declaration", (m) => { m.probes[1] = m.probes[0]!; }],
    ["unknown declaration", (m) => { m.probes[0] = { ...m.probes[0]!, id: "invented.probe" }; }],
    ["required changed to optional", (m) => { m.probes[0] = { ...m.probes[0]!, required: false }; }],
    ["support rewritten", (m) => { m.probes[0] = { ...m.probes[0]!, support: { status: "UNSUPPORTED", reason: "No collector" } }; }],
    ["invalid support status", (m) => { m.probes[0] = { ...m.probes[0]!, support: { status: "MAYBE" } as unknown as ProbeSpec["support"] }; }],
    ["contexts removed", (m) => { m.probes[0] = { ...m.probes[0]!, contexts: [] }; }],
    ["contract relaxed", (m) => { m.probes[0] = { ...m.probes[0]!, contract: "Trust configured log" }; }],
    ["core receipt kind relaxed", (m) => { m.probes = m.probes.map((spec) => spec.id === "identity.full-validator" ? { ...spec, evidenceKind: "capture" } : spec); }],
    ["extra row", (m) => { m.probes.push(m.probes[0]!); }],
  ];
  it.each(changes)("rejects %s instead of obtaining vacuous eligibility", (_name, change) => {
    const f = fixture();
    const manifest = alteredManifest(f.manifest, change);
    expect(() => aggregateFingerprintAcceptance(manifest, f.binding, f.results)).toThrow(/manifest/);
  });

  it("accepts an unchanged JSON roundtrip of the declaration without weakening support", () => {
    const f = fixture();
    const manifest = JSON.parse(JSON.stringify(f.manifest)) as ProbeManifest;
    const results = JSON.parse(JSON.stringify(f.results)) as ProbeResult[];
    expect(aggregateFingerprintAcceptance(manifest, f.binding, results).eligible).toBe(true);
  });

  it.each([null, {}, { probes: [] }])("rejects malformed manifest %j", (manifest) => {
    const f = fixture();
    expect(() => aggregateFingerprintAcceptance(manifest as unknown as ProbeManifest, f.binding, [])).toThrow(/manifest/);
  });

  it("rejects nonarray results rather than inferring success", () => {
    const f = fixture();
    expect(() => aggregateFingerprintAcceptance(f.manifest, f.binding, {} as unknown as readonly ProbeResult[])).toThrow(/array/);
  });
});
