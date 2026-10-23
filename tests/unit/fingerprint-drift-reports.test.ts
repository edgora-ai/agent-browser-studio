import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProfileMeta, ProxyConfig } from "../../src/main/types.js";
import type { Fingerprint } from "../../src/main/services/fingerprint-baseline.js";
import { analyzeFingerprintDrift, diffFingerprintSnapshots } from "../../src/main/services/fingerprint-drift-policy.js";

// Every path getter is synthetic. The filesystem itself, revision journal and
// restore locks are real; only the selected report rename can be fault-injected.
const environment = vi.hoisted(() => ({
  root: "", profilesRoot: "", failRenameTo: "",
  config: {
    browserProfiles: {} as Record<string, BrowserProfileMeta>,
    proxies: {} as Record<string, ProxyConfig>, defaultProxy: "",
  },
}));
vi.mock("../../src/main/services/config-manager.js", () => ({
  getConfig: () => environment.config,
  getAppDataDir: () => {
    if (!environment.root) throw new Error("Synthetic report root was not initialized");
    return environment.root;
  },
  getProfilesDir: () => {
    if (!environment.profilesRoot) throw new Error("Synthetic profile root was not initialized");
    return environment.profilesRoot;
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (source: fs.PathLike, target: fs.PathLike) => {
      if (environment.failRenameTo && String(target) === environment.failRenameTo) {
        throw Object.assign(new Error("Synthetic report publication rename denied"), { code: "EACCES" });
      }
      return actual.renameSync(source, target);
    },
  };
});

type Reports = typeof import("../../src/main/services/fingerprint-drift-reports.js");
type Revisions = typeof import("../../src/main/services/profile-data-revision.js");
type RestoreLocks = typeof import("../../src/main/services/profile-restore-lock.js");
type Stored = {
  schemaVersion: number;
  reports: { report: ReturnType<Reports["saveFingerprintComparison"]>; witness: string; dataRevision: string }[];
};
let reports: Reports;
let revisions: Revisions;
let restoreLocks: RestoreLocks;
let releases: (() => void)[];
const OBSERVED_AT = 1_792_497_600_000;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const BASELINE: Fingerprint = { userAgent: "synthetic old UA", platform: "MacIntel", screenW: 1920, innerHeight: 800, canvasHash: "old-canvas" };
const CURRENT: Fingerprint = { userAgent: "synthetic new UA", platform: "MacIntel", screenW: 1280, innerHeight: 600, canvasHash: "new-canvas" };

const reportFile = () => path.join(environment.root, "fingerprint-comparisons.json");
const rawStore = (): Stored => JSON.parse(fs.readFileSync(reportFile(), "utf8"));
const bytes = () => fs.readFileSync(reportFile(), "utf8");
const metadataFile = (dirId: string) => path.join(environment.profilesRoot, dirId, "synthetic-metadata.json");
function expectedDirectoryWarning(): string | undefined {
  const fd = fs.openSync(environment.root, "r");
  try {
    try { fs.fsyncSync(fd); }
    catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (process.platform !== "win32" || failure.code !== "EPERM" || failure.syscall !== "fsync") throw error;
      return "FINGERPRINT_REPORT_DIRECTORY_SYNC_UNCONFIRMED";
    }
  } finally { fs.closeSync(fd); }
}
function profile(dirId = "profile_A", overrides: Partial<BrowserProfileMeta> = {}): BrowserProfileMeta {
  const meta: BrowserProfileMeta = {
    name: `Synthetic ${dirId}`, engine: "chromium", platform: "macos", fingerprintSeed: 12345,
    proxyMode: "none", proxyName: null, fingerprintBaseline: { ...BASELINE }, ...overrides,
  };
  environment.config.browserProfiles[dirId] = meta;
  fs.mkdirSync(path.dirname(metadataFile(dirId)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(metadataFile(dirId), JSON.stringify(meta), { mode: 0o600 });
  return meta;
}
function input(dirId: string, meta: BrowserProfileMeta, current: Fingerprint = { ...CURRENT }, overrides: Partial<Parameters<Reports["saveFingerprintComparison"]>[1]> = {}) {
  const drift = diffFingerprintSnapshots(meta.fingerprintBaseline, current);
  return {
    dirId, meta, current, analysis: analyzeFingerprintDrift(meta.fingerprintBaseline, current, drift),
    source: "manual" as const, observedAt: OBSERVED_AT, engineVersion: "146.0.2.3", ...overrides,
  };
}
function save(dirId: string, meta: BrowserProfileMeta, current: Fingerprint = { ...CURRENT }, overrides: Partial<Parameters<Reports["saveFingerprintComparison"]>[1]> = {}) {
  const handle = reports.beginFingerprintObservation(dirId, meta);
  return { handle, report: reports.saveFingerprintComparison(handle, input(dirId, meta, current, overrides)) };
}
function retainLock(dirId: string): void {
  releases.push(restoreLocks.acquireRestoreLock(dirId));
}
function routedProfile(mode: "named" | "default") {
  const routeName = "synthetic-shared-route";
  // Opaque synthetic markers only: no credential loading, encryption or decryption.
  const route: ProxyConfig = {
    type: "http", host: "route-a.synthetic.invalid", port: 8080,
    username: "TEST_ONLY_NOT_A_CREDENTIAL_USER_A", password: "TEST_ONLY_NOT_A_CREDENTIAL_AUTH_A",
    bypassList: ["bypass-a.synthetic.invalid"], fallbacks: ["synthetic-fallback-a"], updatedAt: OBSERVED_AT,
  };
  environment.config.proxies = {
    [routeName]: route,
    "synthetic-fallback-a": { type: "http", host: "fallback-a.synthetic.invalid", port: 8080 },
    "synthetic-fallback-b": { type: "http", host: "fallback-b.synthetic.invalid", port: 8080 },
  };
  environment.config.defaultProxy = routeName;
  const meta = profile("profile_A", { proxyMode: mode, proxyName: mode === "named" ? routeName : null });
  return { routeName, route, meta };
}
function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}
async function restart(): Promise<void> {
  vi.resetModules();
  [reports, revisions, restoreLocks] = await Promise.all([
    import("../../src/main/services/fingerprint-drift-reports.js"),
    import("../../src/main/services/profile-data-revision.js"),
    import("../../src/main/services/profile-restore-lock.js"),
  ]);
}

beforeEach(async () => {
  // A bounded, disposable runtime fixture; no retained artifact or production path.
  environment.root = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-reports-test-"));
  environment.profilesRoot = path.join(environment.root, "synthetic-profiles");
  environment.failRenameTo = "";
  environment.config = { browserProfiles: Object.create(null), proxies: Object.create(null), defaultProxy: "" };
  releases = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await restart();
});
afterEach(() => {
  environment.failRenameTo = "";
  for (const release of releases.reverse()) release();
  vi.restoreAllMocks();
  fs.rmSync(environment.root, { recursive: true, force: true });
  environment.root = "";
  environment.profilesRoot = "";
});

describe("fingerprint comparison persistence with a real isolated filesystem", () => {
  it("returns absent only for a genuinely absent store without creating revision/report files", () => {
    const meta = profile();
    expect(reports.readFingerprintComparison("profile_A", meta)).toEqual({ report: null, currentConfigMatches: false, canUpdateBaseline: false });
    expect(revisions.getProfileDataRevision("profile_A")).toBe("initial");
    expect(fs.existsSync(reportFile())).toBe(false);
    expect(fs.existsSync(path.join(environment.root, "profile-data-revisions"))).toBe(false);
    expect(fs.readdirSync(environment.root)).toEqual(["synthetic-profiles"]);
  });

  it.each(["launch", "manual", "baseline"] as const)("writes, inspects raw JSON, reloads and searches by dirId with full old/new values: %s", async (source) => {
    const metaA = profile("profile_A");
    const metaB = profile("profile_B");
    Object.freeze(metaA.fingerprintBaseline);
    const baselineBytes = JSON.stringify(metaA.fingerprintBaseline);
    const metadataBytes = fs.readFileSync(metadataFile("profile_A"), "utf8");
    const capture = Object.freeze({ ...CURRENT });
    const captureBytes = JSON.stringify(capture);
    const analysis = input("profile_A", metaA, capture).analysis;
    const directoryWarning = expectedDirectoryWarning();
    const savedA = save("profile_A", metaA, capture, { source }).report;
    const savedB = save("profile_B", metaB, { ...CURRENT, canvasHash: "B-only-canvas" }, { observedAt: OBSERVED_AT + 1 }).report;
    expect(savedA).toMatchObject({ saved: true, baselineCandidate: true, observedAt: OBSERVED_AT, source });
    expect(savedA.warning).toBe(directoryWarning);
    expect(savedB.saved).toBe(true);
    expect(savedB.warning).toBe(directoryWarning);

    const raw = rawStore();
    expect(raw.schemaVersion).toBe(1);
    expect(raw.reports).toHaveLength(2);
    const persisted = raw.reports.find((entry) => entry.report.dirId === "profile_A")!;
    expect(persisted.witness).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.dataRevision).toBe("initial");
    expect(persisted.report).toMatchObject({ id: savedA.id, saved: true, baselineCandidate: false, source, observedAt: OBSERVED_AT, engineVersion: "146.0.2.3" });
    expect(persisted.report.changes).toEqual(analysis.changes);
    expect(persisted.report.changes.find((row) => row.field === "canvasHash")).toMatchObject({ baseline: "old-canvas", current: "new-canvas", severity: "risk" });
    expect(persisted.report.changes.find((row) => row.field === "innerHeight")).toMatchObject({ baseline: 800, current: 600, severity: "info" });
    expect(persisted.report.fields).toBe(analysis.fields);
    expect(persisted.report.comparedFields).toBe(analysis.comparedFields);
    expect(fs.statSync(reportFile()).size).toBeLessThanOrEqual(MAX_STORE_BYTES);

    await restart();
    const loadedA = reports.readFingerprintComparison("profile_A", metaA);
    const loadedB = reports.readFingerprintComparison("profile_B", metaB);
    expect(loadedA).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: false, report: { id: savedA.id, observedAt: OBSERVED_AT, baselineCandidate: false, saved: true } });
    expect(loadedA.report!.changes).toEqual(persisted.report.changes);
    expect(loadedB.report!.changes.find((row) => row.field === "canvasHash")!.current).toBe("B-only-canvas");
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", savedA.id, metaA), "BASELINE_SNAPSHOT_EXPIRED");
    expect(JSON.stringify(metaA.fingerprintBaseline)).toBe(baselineBytes);
    expect(fs.readFileSync(metadataFile("profile_A"), "utf8")).toBe(metadataBytes);
    expect(JSON.stringify(capture)).toBe(captureBytes);
  });

  it("round-trips readable semantic leaves and complete quoted/escaped UA brand keys", async () => {
    const brand = 'Not/A "Brand"';
    const baseline: Fingerprint = {
      platform: "MacIntel",
      uaHighEntropy: JSON.stringify({ architecture: "arm", brands: [{ brand: "Chromium", version: "145" }, { brand, version: "99" }], fullVersionList: [{ brand, version: "99.0.0.0" }, { brand: "Chromium", version: "145.0.1.2" }] }),
    };
    const current: Fingerprint = {
      platform: "MacIntel",
      uaHighEntropy: JSON.stringify({ fullVersionList: [{ brand: "Chromium", version: "146.0.2.3" }, { brand, version: "8.0.0.0" }], brands: [{ brand, version: "8" }, { brand: "Chromium", version: "146" }], architecture: "x86" }),
    };
    const meta = profile("semantic_profile", { fingerprintBaseline: baseline });
    const expected = input("semantic_profile", meta, current).analysis.changes;
    const saved = save("semantic_profile", meta, current).report;
    expect(saved).toMatchObject({ saved: true, baselineCandidate: true });
    const stored = rawStore().reports.find((entry) => entry.report.dirId === "semantic_profile")!.report;
    expect(stored.changes).toEqual(expected);
    expect(stored.changes.find((row) => row.field === "uaHighEntropy.architecture")).toMatchObject({ baseline: "arm", current: "x86" });
    expect(stored.changes.find((row) => row.field === `uaHighEntropy.fullVersionList[${JSON.stringify(brand)}].version`)).toMatchObject({ baseline: "99.0.0.0", current: "8.0.0.0" });
    await restart();
    expect(reports.readFingerprintComparison("semantic_profile", meta).report!.changes).toEqual(expected);
  });

  it("cannot mint baseline authority from a persisted candidate flag after module restart", async () => {
    const meta = profile();
    const saved = save("profile_A", meta).report;
    const raw = rawStore();
    raw.reports[0].report.baselineCandidate = true;
    fs.writeFileSync(reportFile(), JSON.stringify(raw), { mode: 0o600 });
    await restart();
    expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: false, report: { baselineCandidate: false } });
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", saved.id, meta), "BASELINE_SNAPSHOT_EXPIRED");
    expect(meta.fingerprintBaseline).toEqual(BASELINE);
  });

  it("keeps availability metadata and missing-versus-null context explicit after persistence", async () => {
    const meta = profile();
    const current = { ...CURRENT };
    delete current.screenW;
    const analysis = input("profile_A", meta, current).analysis;
    const saved = save("profile_A", meta, current).report;
    expect(saved).toMatchObject({ saved: true, baselineCandidate: false, partial: true });
    const missing = rawStore().reports[0].report.changes.find((row) => row.field === "screenW");
    expect(missing).toMatchObject({ baseline: 1920, current: null, availability: "probe-unavailable", required: true, severity: "unavailable" });
    expect(saved.changes).toEqual(rawStore().reports[0].report.changes);
    expect(missing!.reason).toBe(analysis.changes.find((row) => row.field === "screenW")!.reason);
    await restart();
    expect(reports.readFingerprintComparison("profile_A", meta).report!.changes.find((row) => row.field === "screenW")).toEqual(missing);
  });

  it("returns detached in-memory candidates without mutating baseline or captured bytes", () => {
    const meta = profile();
    const current = { ...CURRENT };
    const before = JSON.stringify(meta.fingerprintBaseline);
    const { report } = save("profile_A", meta, current);
    const first = reports.getFingerprintBaselineCandidate("profile_A", report.id, meta);
    expect(Object.keys(first).sort()).toEqual(["before", "expiresAt", "report", "snapshot"]);
    expect(first.report.baselineCandidate).toBe(true);
    expect(first.before).toEqual(BASELINE);
    expect(first.snapshot).toEqual(CURRENT);
    first.snapshot.platform = "mutated-return-value";
    current.canvasHash = "mutated-callers-input";
    const second = reports.getFingerprintBaselineCandidate("profile_A", report.id, meta);
    expect(second.snapshot).toEqual(CURRENT);
    expect(JSON.stringify(meta.fingerprintBaseline)).toBe(before);
    expect(JSON.parse(fs.readFileSync(metadataFile("profile_A"), "utf8")).fingerprintBaseline).toEqual(BASELINE);
  });

  it("never refreshes observation/acceptance timestamps or rewrites the store on repeated reads/restart", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(OBSERVED_AT);
    const meta = profile();
    const directoryWarning = expectedDirectoryWarning();
    const saved = save("profile_A", meta).report;
    clock.mockReturnValue(OBSERVED_AT + 1000);
    expect(reports.markFingerprintReferenceAccepted("profile_A", saved.id)).toBe(directoryWarning);
    const original = bytes();
    const stat = fs.statSync(reportFile());
    const initial = reports.readFingerprintComparison("profile_A", meta).report!;
    expect(initial).toMatchObject({ observedAt: OBSERVED_AT, acceptedAt: OBSERVED_AT + 1000 });
    clock.mockReturnValue(OBSERVED_AT + 9_000_000);
    for (let i = 0; i < 3; i++) expect(reports.readFingerprintComparison("profile_A", meta).report).toEqual(initial);
    await restart();
    expect(reports.readFingerprintComparison("profile_A", meta).report).toEqual(initial);
    expect(bytes()).toBe(original);
    const after = fs.statSync(reportFile());
    expect([after.ino, after.mtimeMs, after.ctimeMs, after.size]).toEqual([stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size]);
  });
});

describe("candidate config, observation generation and restore fencing", () => {
  it("allows normal note/name/tag edits without invalidating a captured candidate", () => {
    const meta = profile();
    const saved = save("profile_A", meta).report;
    const edited = { ...meta, name: "Renamed synthetic profile", note: "ordinary note edit", tags: ["reviewed"], updatedAt: OBSERVED_AT + 10 };
    environment.config.browserProfiles.profile_A = edited;
    expect(reports.fingerprintProfileWitness(edited)).toBe(reports.fingerprintProfileWitness(meta));
    expect(reports.readFingerprintComparison("profile_A", edited)).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: true });
    expect(reports.getFingerprintBaselineCandidate("profile_A", saved.id, edited).snapshot).toEqual(CURRENT);
    expect(edited.fingerprintBaseline).toEqual(BASELINE);
  });

  it.each([
    ["baseline", (meta: BrowserProfileMeta) => ({ ...meta, fingerprintBaseline: { ...meta.fingerprintBaseline, canvasHash: "externally-edited-baseline" } })],
    ["seed", (meta: BrowserProfileMeta) => ({ ...meta, fingerprintSeed: 54321 })],
    ["proxy", (meta: BrowserProfileMeta) => ({ ...meta, proxyMode: "named" as const, proxyName: "synthetic-proxy" })],
  ] as const)("rejects %s changes after capture without overwriting the report", (_label, edit) => {
    const meta = profile();
    const { handle, report } = save("profile_A", meta);
    const original = bytes();
    const edited = edit(meta);
    environment.config.browserProfiles.profile_A = edited;
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", report.id, edited), "BASELINE_CONFIRMATION_STALE");
    expect(reports.readFingerprintComparison("profile_A", edited)).toMatchObject({ currentConfigMatches: false, canUpdateBaseline: false });
    const stale = reports.saveFingerprintComparison(handle, input("profile_A", edited));
    expect(stale).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_STALE" });
    expect(bytes()).toBe(original);
  });

  describe.each(["named", "default"] as const)("same-name %s proxy routes", (mode) => {
    const edits: [string, Partial<ProxyConfig>][] = [
      ["endpoint host", { host: "route-b.synthetic.invalid" }],
      ["endpoint port", { port: 8081 }],
      ["transport", { type: "socks5h" }],
      ["bypass route", { bypassList: ["bypass-b.synthetic.invalid"] }],
      ["fallback route", { fallbacks: ["synthetic-fallback-b"] }],
      ["stored username", { username: "TEST_ONLY_NOT_A_CREDENTIAL_USER_B" }],
      ["stored auth", { password: "TEST_ONLY_NOT_A_CREDENTIAL_AUTH_B" }],
    ];
    it.each(edits)("rejects %s edits with the profile metadata and selected name unchanged", (_field, patch) => {
      const { routeName, route, meta } = routedProfile(mode);
      const metadata = JSON.stringify(meta);
      const original = save("profile_A", meta);
      expect(original.report).toMatchObject({ saved: true, baselineCandidate: true });
      const stored = bytes();
      environment.config.proxies[routeName] = { ...route, ...patch };
      expect(environment.config.defaultProxy).toBe(routeName);
      expect(JSON.stringify(meta)).toBe(metadata);
      expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", original.report.id, meta), "BASELINE_CONFIRMATION_STALE");
      expect(reports.readFingerprintComparison("profile_A", meta).canUpdateBaseline).toBe(false);
      const stale = reports.saveFingerprintComparison(original.handle, input("profile_A", meta));
      expect(stale).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_STALE" });
      expect(bytes()).toBe(stored);
      expect(meta.fingerprintBaseline).toEqual(BASELINE);
    });

    it("keeps nonsecret endpoint evidence durable so an endpoint edit is still visible after restart", async () => {
      const { routeName, route, meta } = routedProfile(mode);
      const original = save("profile_A", meta).report;
      const oldWitness = rawStore().reports[0].witness;
      const oldBytes = bytes();
      await restart();
      environment.config.proxies[routeName] = { ...route, host: "route-b.synthetic.invalid", port: 8081 };
      expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ currentConfigMatches: false, canUpdateBaseline: false, report: { id: original.id } });
      expect(bytes()).toBe(oldBytes);
      expect(save("profile_A", meta).report.saved).toBe(true);
      expect(rawStore().reports[0].witness).not.toBe(oldWitness);
      expect(meta.fingerprintBaseline).toEqual(BASELINE);
    });

    it("keeps credential-bearing identity strictly in memory, not raw data or a credential hash on disk", async () => {
      const { routeName, route, meta } = routedProfile(mode);
      const first = save("profile_A", meta).report;
      const firstWitness = rawStore().reports[0].witness;
      const changed: ProxyConfig = {
        ...route, username: "TEST_ONLY_NOT_A_CREDENTIAL_USER_B", password: "TEST_ONLY_NOT_A_CREDENTIAL_AUTH_B",
      };
      environment.config.proxies[routeName] = changed;
      expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", first.id, meta), "BASELINE_CONFIRMATION_STALE");
      const fresh = save("profile_A", meta).report;
      expect(fresh).toMatchObject({ saved: true, baselineCandidate: true });
      const persisted = rawStore();
      // Auth-only changes must not influence the persisted witness through a
      // deterministic credential digest (nor a persisted process-HMAC).
      expect(persisted.reports[0].witness).toBe(firstWitness);
      const text = bytes();
      for (const marker of [route.username!, route.password!, changed.username!, changed.password!, JSON.stringify(route), JSON.stringify(changed)]) {
        expect(text).not.toContain(marker);
        expect(text).not.toContain(createHash("sha256").update(marker).digest("hex"));
      }
      function inspectKeys(value: unknown): void {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          expect(key).not.toMatch(/credential|username|password|hmac|authWitness|authIdentity/i);
          inspectKeys(child);
        }
      }
      inspectKeys(persisted);
      await restart();
      expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ canUpdateBaseline: false, report: { id: fresh.id } });
      expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", fresh.id, meta), "BASELINE_SNAPSHOT_EXPIRED");
    });
  });

  it("uses an actual durable data revision to reject restore changes, then permits a fresh observation", async () => {
    const meta = profile();
    const { report } = save("profile_A", meta);
    const before = bytes();
    expect(revisions.getProfileDataRevision("profile_A")).toBe("initial");
    revisions.markProfileDataChanging("profile_A");
    const recordPath = path.join(environment.root, "profile-data-revisions", "profile_A.json");
    const revision = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    expect(revision).toMatchObject({ version: 1, dirId: "profile_A", revision: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(revisions.getProfileDataRevision("profile_A")).toBe(revision.revision);
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", report.id, meta), "BASELINE_CONFIRMATION_STALE");
    expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ currentConfigMatches: false, canUpdateBaseline: false });
    expect(bytes()).toBe(before);
    const fresh = save("profile_A", meta, { ...CURRENT, canvasHash: "after-synthetic-restore" }).report;
    expect(fresh.saved).toBe(true);
    expect(rawStore().reports[0].dataRevision).toBe(revision.revision);
    await restart();
    expect(revisions.getProfileDataRevision("profile_A")).toBe(revision.revision);
    expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: false, report: { id: fresh.id } });
    expect(meta.fingerprintBaseline).toEqual(BASELINE);
  });

  it("rejects an observation if data revision changes before publication", () => {
    const meta = profile();
    const handle = reports.beginFingerprintObservation("profile_A", meta);
    revisions.markProfileDataChanging("profile_A");
    const stale = reports.saveFingerprintComparison(handle, input("profile_A", meta));
    expect(stale).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_STALE" });
    expect(fs.existsSync(reportFile())).toBe(false);
  });

  it("does not let an older late observation overwrite the newer report or candidate", () => {
    const meta = profile();
    const old = reports.beginFingerprintObservation("profile_A", meta);
    const latest = reports.beginFingerprintObservation("profile_A", meta);
    const newest = reports.saveFingerprintComparison(latest, input("profile_A", meta, { ...CURRENT, canvasHash: "newest" }, { observedAt: OBSERVED_AT + 100 }));
    expect(newest.saved).toBe(true);
    const original = bytes();
    const stale = reports.saveFingerprintComparison(old, input("profile_A", meta, { ...CURRENT, canvasHash: "older-late" }));
    expect(stale).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_STALE" });
    expect(bytes()).toBe(original);
    expect(reports.getFingerprintBaselineCandidate("profile_A", newest.id, meta).snapshot.canvasHash).toBe("newest");
  });

  it("clear invalidates old observations/candidates and cannot be undone by their late completion", () => {
    const metaA = profile("profile_A");
    const metaB = profile("profile_B");
    const a = save("profile_A", metaA);
    const b = save("profile_B", metaB);
    reports.clearFingerprintComparison("profile_A");
    const afterClear = bytes();
    expect(rawStore().reports.map((entry) => entry.report.dirId)).toEqual(["profile_B"]);
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", a.report.id, metaA), "BASELINE_SNAPSHOT_EXPIRED");
    expect(reports.saveFingerprintComparison(a.handle, input("profile_A", metaA))).toMatchObject({ saved: false, warning: "FINGERPRINT_REPORT_STALE" });
    expect(bytes()).toBe(afterClear);
    expect(reports.readFingerprintComparison("profile_A", metaA).report).toBeNull();
    expect(reports.readFingerprintComparison("profile_B", metaB).report!.id).toBe(b.report.id);
  });

  it("rechecks the caller currentness fence immediately before publishing", () => {
    const meta = profile();
    save("profile_A", meta);
    const before = bytes();
    const handle = reports.beginFingerprintObservation("profile_A", meta);
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(reports.saveFingerprintComparison(handle, input("profile_A", meta, CURRENT, { isCurrent }))).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_STALE" });
    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(bytes()).toBe(before);
  });

  it("binds an observation to its own dirId even when two profiles have identical identity witnesses", () => {
    const metaA = profile("profile_A");
    const metaB = profile("profile_B");
    expect(reports.fingerprintProfileWitness(metaA)).toBe(reports.fingerprintProfileWitness(metaB));
    const handleA = reports.beginFingerprintObservation("profile_A", metaA);
    const crossed = reports.saveFingerprintComparison(handleA, input("profile_B", metaB));
    expect(crossed).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_STALE" });
    expect(fs.existsSync(reportFile())).toBe(false);
  });

  it("refuses a new observation while the actual restore lock is held", () => {
    const meta = profile();
    retainLock("profile_A");
    expectCode(() => reports.beginFingerprintObservation("profile_A", meta), "PROFILE_RESTORE_IN_PROGRESS");
    expect(fs.existsSync(reportFile())).toBe(false);
    expect(fs.lstatSync(path.join(environment.root, "locks", "profile_A.restore.lock")).isFile()).toBe(true);
  });

  it("also fences an existing observation/candidate when a restore lock is acquired after capture", () => {
    const meta = profile();
    const captured = save("profile_A", meta);
    const before = bytes();
    retainLock("profile_A");
    expect(() => reports.getFingerprintBaselineCandidate("profile_A", captured.report.id, meta)).toThrow();
    expect(reports.readFingerprintComparison("profile_A", meta).canUpdateBaseline).toBe(false);
    const late = reports.saveFingerprintComparison(captured.handle, input("profile_A", meta));
    expect(late).toMatchObject({ saved: false, baselineCandidate: false });
    expect(late.warning).toMatch(/STALE|RESTORE/);
    expect(bytes()).toBe(before);
  });

  it("does not reclaim a stale disk restore lock as a side effect of reopening readable reports", async () => {
    const meta = profile();
    save("profile_A", meta);
    const reportBytes = bytes();
    const lockPath = path.join(environment.root, "locks", "profile_A.restore.lock");
    const lockBytes = JSON.stringify({ pid: 1_234_567_890, token: "synthetic-stale-token", dirId: "profile_A" });
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, lockBytes, { mode: 0o600 });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Synthetic exited PID"), { code: "ESRCH" });
    });
    expect(reports.readFingerprintComparison("profile_A", meta).canUpdateBaseline).toBe(false);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(lockBytes);
    await restart();
    expect(reports.readFingerprintComparison("profile_A", meta).report).not.toBeNull();
    expect(fs.readFileSync(lockPath, "utf8")).toBe(lockBytes);
    expect(bytes()).toBe(reportBytes);
  });

  it.each(["chromium", "firefox"] as const)("keeps observed %s distinct from future saved engine intent and refuses snapshot authority", async (engine) => {
    const meta = profile("profile_A", { engine: engine === "chromium" ? "firefox" : "chromium" });
    const saved = save("profile_A", meta, CURRENT, { engine }).report;
    expect(saved).toMatchObject({ engine, saved: true, baselineCandidate: false });
    expect(rawStore().reports[0].report.engine).toBe(engine);
    expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ currentConfigMatches: false, canUpdateBaseline: false });
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", saved.id, meta), "BASELINE_SNAPSHOT_EXPIRED");
    await restart();
    expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ report: { engine }, currentConfigMatches: false, canUpdateBaseline: false });
  });

  it("expires in-memory authority without deleting/re-dating the persisted evidence", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(OBSERVED_AT);
    const meta = profile();
    const saved = save("profile_A", meta).report;
    const original = bytes();
    clock.mockReturnValue(OBSERVED_AT + 30 * 60 * 1000 + 1);
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", saved.id, meta), "BASELINE_SNAPSHOT_EXPIRED");
    expect(reports.readFingerprintComparison("profile_A", meta)).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: false, report: { observedAt: OBSERVED_AT } });
    expect(bytes()).toBe(original);
  });
});

describe("bounded report retention and explicit filesystem failures", () => {
  it("retains at most 20 profiles and keeps the newest dirId-searchable old/new values across restart", async () => {
    const metas = new Map<string, BrowserProfileMeta>();
    for (let index = 0; index < 21; index++) {
      const dirId = `bounded_${String(index).padStart(2, "0")}`;
      const meta = profile(dirId);
      metas.set(dirId, meta);
      expect(save(dirId, meta, { ...CURRENT, canvasHash: `sample-${index}` }, { observedAt: OBSERVED_AT + index }).report.saved).toBe(true);
    }
    const raw = rawStore();
    expect(raw.reports).toHaveLength(20);
    expect(raw.reports.map((entry) => entry.report.dirId)).toEqual([...metas.keys()].slice(1));
    expect(fs.statSync(reportFile()).size).toBeLessThanOrEqual(MAX_STORE_BYTES);
    await restart();
    expect(reports.readFingerprintComparison("bounded_00", metas.get("bounded_00")!).report).toBeNull();
    for (const [dirId, meta] of [...metas].slice(1)) {
      const read = reports.readFingerprintComparison(dirId, meta);
      expect(read).toMatchObject({ currentConfigMatches: true, canUpdateBaseline: false });
      expect(read.report!.changes.find((row) => row.field === "canvasHash")).toMatchObject({ baseline: "old-canvas", current: `sample-${Number(dirId.slice(-2))}` });
    }
  });

  it("evicts older large reports to respect the real 4 MiB file budget, not only the count limit", async () => {
    const oldSignal = "a".repeat(60_000);
    const newSignal = "b".repeat(60_000);
    const baseline = { userAgent: oldSignal, plugins: oldSignal, fontAvailability: oldSignal, mimeTypes: "old".repeat(6500) };
    const current = { userAgent: newSignal, plugins: newSignal, fontAvailability: newSignal, mimeTypes: "new".repeat(6500) };
    for (let index = 0; index < 12; index++) {
      const dirId = `large_${String(index).padStart(2, "0")}`;
      const meta = profile(dirId, { fingerprintBaseline: baseline });
      expect(save(dirId, meta, current, { observedAt: OBSERVED_AT + index }).report.saved).toBe(true);
      expect(fs.statSync(reportFile()).size).toBeLessThanOrEqual(MAX_STORE_BYTES);
    }
    const raw = rawStore();
    expect(raw.reports.length).toBeLessThan(12);
    expect(raw.reports.length).toBeGreaterThan(1);
    expect(raw.reports.at(-1)!.report.dirId).toBe("large_11");
    expect(raw.reports.some((entry) => entry.report.dirId === "large_00")).toBe(false);
    await restart();
    const loaded = reports.readFingerprintComparison("large_11", environment.config.browserProfiles.large_11).report!;
    expect(loaded.changes.find((row) => row.field === "fontAvailability")).toMatchObject({ baseline: oldSignal, current: newSignal });
  });

  it("includes the serialized trailing newline in the exact 4 MiB publication budget", async () => {
    const baseline = { userAgent: "a".repeat(60_000), plugins: "a".repeat(60_000), fontAvailability: "a".repeat(60_000), mimeTypes: "old".repeat(6500) };
    const current = { userAgent: "b".repeat(60_000), plugins: "b".repeat(60_000), fontAvailability: "b".repeat(60_000), mimeTypes: "new".repeat(6500) };
    for (let index = 0; index < 10; index++) {
      const dirId = `exact_${index}`;
      expect(save(dirId, profile(dirId, { fingerprintBaseline: baseline }), current).report.saved).toBe(true);
    }
    const meta = profile("budget_A");
    expect(save("budget_A", meta).report.saved).toBe(true);
    const store = rawStore();
    const template = store.reports.find((entry) => entry.report.dirId === "budget_A")!;
    const retained = store.reports.filter((entry) => entry.report.dirId !== "budget_A");
    const sizeWithTemplate = () => Buffer.byteLength(JSON.stringify({ schemaVersion: 1, reports: [...retained, template] }));
    let padding = MAX_STORE_BYTES - sizeWithTemplate();
    expect(padding).toBeGreaterThan(0);
    // Pad only valid bounded JSON scalar values in our own fixture. UUIDs are
    // fixed-width, so a new report with the same inputs has this exact byte size.
    for (const entry of retained) {
      const row = entry.report.changes.find((change) => change.field === "userAgent")!;
      const valueBytes = Buffer.byteLength(JSON.stringify(row.baseline));
      const reportBytes = Buffer.byteLength(JSON.stringify(entry.report));
      const added = Math.min(padding, 128 * 1024 - valueBytes, 512 * 1024 - reportBytes);
      row.baseline = String(row.baseline) + "p".repeat(added);
      padding -= added;
      if (padding === 0) break;
    }
    expect(padding).toBe(0);
    expect(sizeWithTemplate()).toBe(MAX_STORE_BYTES);
    fs.writeFileSync(reportFile(), JSON.stringify({ schemaVersion: 1, reports: retained }) + "\n", { mode: 0o600 });
    expect(fs.statSync(reportFile()).size).toBeLessThan(MAX_STORE_BYTES);
    await restart();
    const published = save("budget_A", meta).report;
    expect(published.saved).toBe(true);
    expect(fs.statSync(reportFile()).size).toBeLessThanOrEqual(MAX_STORE_BYTES);
    expect(reports.readFingerprintComparison("budget_A", meta).report!.id).toBe(published.id);
  });

  it.each(["{broken", "null", '{"schemaVersion":2,"reports":[]}', '{"schemaVersion":1,"reports":[{}]}'])("does not turn a corrupt store into a false empty result or overwrite it: %s", (corrupt) => {
    const meta = profile();
    fs.writeFileSync(reportFile(), corrupt, { mode: 0o600 });
    expect(() => reports.readFingerprintComparison("profile_A", meta)).toThrow();
    expect(() => reports.clearFingerprintComparison("profile_A")).toThrow();
    const result = save("profile_A", meta).report;
    expect(result).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_SAVE_FAILED" });
    expect(bytes()).toBe(corrupt);
    expect(console.warn).toHaveBeenCalled();
  });

  it.each(["symlink", "hardlink", "directory"] as const)("rejects a non-private report file (%s) without following/overwriting its target", (kind) => {
    const meta = profile();
    const target = path.join(environment.root, "synthetic-link-target.json");
    const targetBytes = '{"schemaVersion":1,"reports":[]}';
    fs.writeFileSync(target, targetBytes, { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(target, reportFile());
    else if (kind === "hardlink") fs.linkSync(target, reportFile());
    else fs.mkdirSync(reportFile(), { mode: 0o700 });
    expect(() => reports.readFingerprintComparison("profile_A", meta)).toThrow();
    expect(() => reports.clearFingerprintComparison("profile_A")).toThrow();
    const failed = save("profile_A", meta).report;
    expect(failed).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORTS_UNAVAILABLE" });
    // This direct path is our own real fixture, not a read through the test link.
    expect(fs.readFileSync(target, "utf8")).toBe(targetBytes);
    if (kind === "symlink") expect(fs.readlinkSync(reportFile())).toBe(target);
    expect(fs.readdirSync(environment.root).filter((name) => name.startsWith("fingerprint-comparisons.json.tmp-"))).toEqual([]);
  });

  it("rejects an oversized existing store explicitly without truncating it or returning empty", () => {
    const meta = profile();
    fs.writeFileSync(reportFile(), Buffer.alloc(MAX_STORE_BYTES + 1, 0x20), { mode: 0o600 });
    expect(() => reports.readFingerprintComparison("profile_A", meta)).toThrow();
    expect(() => reports.clearFingerprintComparison("profile_A")).toThrow();
    expect(save("profile_A", meta).report).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORTS_UNAVAILABLE" });
    expect(fs.statSync(reportFile()).size).toBe(MAX_STORE_BYTES + 1);
    expect(fs.readFileSync(reportFile()).equals(Buffer.alloc(MAX_STORE_BYTES + 1, 0x20))).toBe(true);
  });

  it("reports rename failure, preserves the old report bytes, and removes its own temporary file", async () => {
    const meta = profile();
    const original = save("profile_A", meta).report;
    const before = bytes();
    environment.failRenameTo = reportFile();
    const failed = save("profile_A", meta, { ...CURRENT, canvasHash: "must-not-publish" }).report;
    expect(failed).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_SAVE_FAILED" });
    expectCode(() => reports.getFingerprintBaselineCandidate("profile_A", failed.id, meta), "BASELINE_SNAPSHOT_EXPIRED");
    expect(bytes()).toBe(before);
    expect(fs.readdirSync(environment.root).filter((name) => name.startsWith("fingerprint-comparisons.json.tmp-"))).toEqual([]);
    environment.failRenameTo = "";
    await restart();
    expect(reports.readFingerprintComparison("profile_A", meta).report!.id).toBe(original.id);
    expect(reports.readFingerprintComparison("profile_A", meta).report!.changes.find((row) => row.field === "canvasHash")!.current).toBe("new-canvas");
  });

  it("refuses a too-large individual report rather than claiming it was saved", () => {
    const meta = profile();
    const capture = input("profile_A", meta);
    capture.analysis.changes = Array.from({ length: 5 }, (_, index) => ({
      field: ["userAgent", "platform", "plugins", "mimeTypes", "fontAvailability"][index],
      baseline: "a".repeat(60_000), current: "b".repeat(60_000), category: "identity" as const, severity: "risk" as const, reason: "identity-changed",
    }));
    capture.analysis.counts = { risk: 5, review: 0, info: 0, unavailable: 0 };
    const handle = reports.beginFingerprintObservation("profile_A", meta);
    expect(reports.saveFingerprintComparison(handle, capture)).toMatchObject({ saved: false, baselineCandidate: false, warning: "FINGERPRINT_REPORT_SAVE_FAILED" });
    expect(fs.existsSync(reportFile())).toBe(false);
  });

  it("does not treat corrupt data-revision evidence as the initial revision or authorize a candidate", () => {
    const meta = profile();
    const { report } = save("profile_A", meta);
    revisions.markProfileDataChanging("profile_A");
    const recordPath = path.join(environment.root, "profile-data-revisions", "profile_A.json");
    fs.writeFileSync(recordPath, "{corrupt", { mode: 0o600 });
    expect(() => reports.readFingerprintComparison("profile_A", meta)).toThrow();
    expect(() => reports.getFingerprintBaselineCandidate("profile_A", report.id, meta)).toThrow();
    expect(() => reports.beginFingerprintObservation("profile_A", meta)).toThrow();
    expect(rawStore().reports[0].report.id).toBe(report.id);
  });
});
