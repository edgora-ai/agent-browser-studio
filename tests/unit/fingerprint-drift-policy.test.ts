import { describe, expect, it } from "vitest";
import {
  analyzeFingerprintDrift,
  classifyFingerprintDrift,
  diffFingerprintSnapshots,
  isFingerprintSnapshotEquivalent,
  type FingerprintDrift,
} from "../../src/main/services/fingerprint-drift-policy.js";

type Snapshot = Record<string, unknown>;
function analyze(baseline: Snapshot | null | undefined, current: Snapshot, options?: { expectedBrowserVersion?: string | null; observedAt?: number }) {
  return analyzeFingerprintDrift(baseline, current, diffFingerprintSnapshots(baseline, current), options);
}
const json = JSON.stringify;
const ua = (version: string) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
function chromium(version: string): Snapshot {
  const major = version.split(".")[0];
  return {
    userAgent: ua(version), appVersion: ua(version).slice("Mozilla/".length), uaPlatform: "macOS",
    uaHighEntropy: json({
      architecture: "arm", bitness: "64", mobile: false, platform: "macOS", platformVersion: "15.0.0", wow64: false,
      brands: [{ brand: "Not_A Brand", version: "99" }, { brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }],
      fullVersionList: [{ brand: "Not_A Brand", version: "99.0.0.0" }, { brand: "Chromium", version }, { brand: "Google Chrome", version }],
    }),
    workerIdentity: json({ userAgent: ua(version), platform: "MacIntel", languages: "en-US,en", hardwareConcurrency: 8, tz: "UTC", tzOffset: 0 }),
  };
}

const IDENTITY_CASES: [string, unknown, unknown][] = [
  ["userAgent", "UA A", "UA B"], ["appVersion", "Version A", "Version B"],
  ["platform", "MacIntel", "Win32"], ["uaPlatform", "macOS", "Windows"],
  ["architecture", "arm", "x86"], ["bitness", "64", "32"], ["wow64", false, true], ["mobile", false, true],
  ["screenW", 1920, 1280], ["screenH", 1080, 1024], ["devicePixelRatio", 2, 1],
  ["hardwareConcurrency", 8, 16], ["deviceMemory", 8, 4], ["maxTouchPoints", 0, 1],
  ["colorDepth", 24, 30], ["pixelDepth", 24, 30], ["language", "en-US", "en-GB"], ["languages", "en-US,en", "en,en-US"],
  ["tz", "America/New_York", "Europe/London"], ["plugins", "", "PDF|internal|PDF viewer"], ["mimeTypes", "application/pdf|pdf", ""],
  ["fontAvailability", "Arial|true", "Arial|false"], ["canvasLen", 100, 101],
  ["glVendor", "WebKit", "Other"], ["glUnmaskedVendor", "Apple", "Intel"], ["glRenderer", "Apple M1", "Intel Iris"],
  ["webgpuVendor", "apple", "intel"], ["webgpuArchitecture", "", "gen-12"], ["webgpuDevice", "0", "1"],
  ["webgpuDescription", "GPU A", "GPU B"], ["webgpuSubgroupMinSize", 0, 4], ["webgpuSubgroupMaxSize", 32, 64], ["webgpuIsFallbackAdapter", false, true],
];

describe("pure fingerprint drift policy: ordinary workflow versus identity", () => {
  it.each(IDENTITY_CASES)("preserves the valid %s invariant", (field, baseline, current) => {
    const result = analyze({ [field]: baseline }, { [field]: current });
    expect(result.drift).toEqual([{ field, baseline, current }]);
    expect(result.changes[0]).toMatchObject({ category: "identity", severity: "risk", reason: "identity-changed" });
    expect(result.risky).toBe(true);
    expect(isFingerprintSnapshotEquivalent({ [field]: baseline }, { [field]: current })).toBe(false);
  });

  it.each(["canvasHash", "audioHash", "fontCapabilityHash", "webglCapabilityHash", "webgpuCapabilityHash"])("does not invent an environmental cause for %s", (field) => {
    expect(analyze({ [field]: "aabb" }, { [field]: "ccdd" }).changes).toEqual([
      { field, baseline: "aabb", current: "ccdd", category: "identity", severity: "risk", reason: "opaque-signal-change" },
    ]);
  });

  it("allows normal height/resize/sidebar/window movement/workarea/theme changes without hiding captured values", () => {
    const baseline = Object.freeze({
      screenW: 1920, screenH: 1080, devicePixelRatio: 2, canvasHash: "seeded", platform: "MacIntel",
      screenX: 0, screenY: 32, innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900,
      availW: 1920, availH: 1055, availLeft: 0, availTop: 25, preferredColorScheme: "light",
      systemColors: '{"preferred":{"Canvas":"rgb(255, 255, 255)","CanvasText":"rgb(0, 0, 0)"}}', storageQuota: 1000,
    });
    const bytes = json(baseline);
    const current = Object.freeze({
      ...baseline, screenX: -1920, screenY: 33, innerWidth: 900, innerHeight: 600, outerWidth: 1000, outerHeight: 700,
      availW: 1900, availH: 1030, availLeft: -1920, availTop: 0, preferredColorScheme: "dark",
      systemColors: '{"preferred":{"CanvasText":"rgb(255, 255, 255)","Canvas":"rgb(0, 0, 0)"}}', storageQuota: 900,
    });
    const currentBytes = json(current);
    const result = analyze(baseline, current);
    expect(result.counts).toEqual({ risk: 0, review: 0, info: 14, unavailable: 0 });
    expect(result.changes.filter((row) => row.category === "window")).toHaveLength(10);
    expect(result.changes.find((row) => row.field === "screenY")).toMatchObject({ baseline: 32, current: 33, reason: "window-geometry" });
    expect(result.changes.find((row) => row.field === "systemColors.preferred.Canvas")).toMatchObject({ reason: "display-environment" });
    expect(result).toMatchObject({ risky: false, partial: false, blockingUnavailable: false, fields: 18, baselineFields: 18, availableFields: 18, comparedFields: 19 });
    expect(isFingerprintSnapshotEquivalent(baseline, current)).toBe(true);
    expect(json(baseline)).toBe(bytes);
    expect(json(current)).toBe(currentBytes);
  });

  it.each([
    ["mediaDevices", "audioinput|", "audioinput|Built-in microphone"],
    ["speechVoices", "", "Alex|en-US|true|true"],
    ["clientRect", "-10000,-10000,160,15", "-10000,-10000,162,15"],
    ["doNotTrack", null, "1"],
  ])("requires review, not a hard identity block or a guessed explanation, for %s", (field, baseline, current) => {
    const result = analyze({ [field as string]: baseline }, { [field as string]: current });
    expect(result).toMatchObject({ risky: false, partial: false });
    expect(result.changes[0]).toMatchObject({ category: "environment", severity: "review", reason: "runtime-environment" });
    expect(isFingerprintSnapshotEquivalent({ [field as string]: baseline }, { [field as string]: current })).toBe(false);
  });

  it("does not lose unknown changed fields, including extra identity leaves", () => {
    const result = analyze(
      { futureSurface: "a", uaHighEntropy: json({ architecture: "arm", futureModel: "A" }) },
      { futureSurface: "b", uaHighEntropy: json({ architecture: "arm", futureModel: "B" }) },
    );
    expect(result.changes.map((row) => [row.field, row.severity, row.reason])).toEqual([
      ["futureSurface", "review", "unknown-field"], ["uaHighEntropy.futureModel", "review", "unknown-field"],
    ]);
    expect(isFingerprintSnapshotEquivalent({ futureSurface: "a" }, { futureSurface: "b" })).toBe(false);
    const unusualWorker = analyze({ workerIdentity: json({ platform: "MacIntel", innerHeight: 800 }) }, { workerIdentity: json({ platform: "MacIntel", innerHeight: 600 }) });
    expect(unusualWorker.changes[0]).toMatchObject({ field: "workerIdentity.innerHeight", severity: "review", reason: "unknown-field" });
    expect(isFingerprintSnapshotEquivalent({ workerIdentity: json({ innerHeight: 800 }) }, { workerIdentity: json({ innerHeight: 600 }) })).toBe(false);
  });
});

describe("semantic JSON identity comparison", () => {
  it("ignores object key order and UA brand order, not architecture or language order", () => {
    const baseline = chromium("145.0.1.2");
    const he = JSON.parse(baseline.uaHighEntropy as string);
    const current = {
      ...baseline,
      uaHighEntropy: json({ ...Object.fromEntries(Object.entries(he).reverse()), brands: [...he.brands].reverse(), fullVersionList: [...he.fullVersionList].reverse() }),
      workerIdentity: json(Object.fromEntries(Object.entries(JSON.parse(baseline.workerIdentity as string)).reverse())),
    };
    const bytes = json(baseline);
    expect(diffFingerprintSnapshots(baseline, current)).toEqual([]);
    expect(isFingerprintSnapshotEquivalent(baseline, current)).toBe(true);
    expect(diffFingerprintSnapshots(baseline, { ...current, uaHighEntropy: json({ ...he, architecture: "x86" }) })).toEqual([
      { field: "uaHighEntropy.architecture", baseline: "arm", current: "x86" },
    ]);
    expect(analyze({ workerIdentity: json({ languages: "en-US,en" }) }, { workerIdentity: json({ languages: "en,en-US" }) }).changes[0]).toMatchObject({ field: "workerIdentity.languages", severity: "risk" });
    expect(json(baseline)).toBe(bytes);
  });

  it("preserves ordered non-brand arrays and nested unknown leaves", () => {
    const result = analyze(
      { uaHighEntropy: json({ architecture: "arm", future: { languages: ["en-US", "en"] } }) },
      { uaHighEntropy: json({ architecture: "arm", future: { languages: ["en", "en-US"] } }) },
    );
    expect(result.drift).toEqual([
      { field: "uaHighEntropy.future.languages[0]", baseline: "en-US", current: "en" },
      { field: "uaHighEntropy.future.languages[1]", baseline: "en", current: "en-US" },
    ]);
    expect(result.counts.review).toBe(2);
  });

  it("treats valid brand membership changes as identity changes, not missing probes", () => {
    const baseline = { uaHighEntropy: json({ brands: [{ brand: "Chromium", version: "145" }] }) };
    const current = { uaHighEntropy: json({ brands: [{ brand: "Chromium", version: "145" }, { brand: "New Brand", version: "1" }] }) };
    const result = analyze(baseline, current);
    expect(result.changes).toHaveLength(2);
    expect(result.changes.every((row) => row.severity === "risk" && row.collectionChange === true && !row.availability)).toBe(true);
    expect(analyze(current, baseline).risky).toBe(true);
    expect(analyze(baseline, { uaHighEntropy: json({ brands: [] }) })).toMatchObject({ risky: true, partial: false });
  });

  it("normalizes legacy whole-JSON diff rows only when their bytes match the actual snapshots", () => {
    const baseline = { uaHighEntropy: '{"architecture":"arm","bitness":"64"}' };
    const reordered = { uaHighEntropy: '{"bitness":"64","architecture":"arm"}' };
    const raw = { field: "uaHighEntropy", baseline: baseline.uaHighEntropy, current: reordered.uaHighEntropy };
    expect(analyzeFingerprintDrift(baseline, reordered, [raw]).changes).toEqual([]);
    const current = { uaHighEntropy: '{"bitness":"64","architecture":"x86"}' };
    const result = analyzeFingerprintDrift(baseline, current, [{ ...raw, current: current.uaHighEntropy }]);
    expect(result.changes).toEqual([
      { field: "uaHighEntropy.architecture", baseline: "arm", current: "x86", category: "identity", severity: "risk", reason: "identity-changed" },
    ]);
    expect(analyzeFingerprintDrift(baseline, reordered, [{ ...raw, current: '{"architecture":"other"}' }]).risky).toBe(true);
  });

  it.each([
    { brands: [{ brand: "Chromium", version: "145" }, { brand: "Chromium", version: "146" }] },
    { fullVersionList: [{ brand: "Chromium", version: "145.0.1.2" }, { brand: " chromium ", version: "145.0.1.2" }] },
    { brands: [{ brand: "Chromium", version: 145 }] },
    { brands: [{ brand: "Chromium" }] },
    { brands: { Chromium: "145" } },
    { brands: ["Chromium"] },
  ])("rejects invalid/duplicate logical brand lists even if both snapshots contain the same bytes: %j", (invalid) => {
    const fp = { uaHighEntropy: json(invalid) };
    const result = analyze(fp, fp);
    expect(result.changes[0]).toMatchObject({ field: "uaHighEntropy", availability: "invalid", severity: "unavailable" });
    expect(result).toMatchObject({ risky: false, partial: true, availableFields: 0, comparedFields: 0 });
    expect(isFingerprintSnapshotEquivalent(fp, fp)).toBe(false);
  });

  it.each(["architecture", "bitness", "wow64", "mobile"])("does not accept wrong JSON types for %s", (field) => {
    const baselineValue = field === "architecture" ? "arm" : field === "bitness" ? "64" : false;
    const baseline = { uaHighEntropy: json({ [field]: baselineValue }) };
    for (const invalid of [null, {}, [], field === "architecture" || field === "bitness" ? 64 : "false"]) {
      const result = analyze(baseline, { uaHighEntropy: json({ [field]: invalid }) });
      expect(result.changes[0]).toMatchObject({ field: `uaHighEntropy.${field}`, availability: "invalid", severity: "unavailable", required: true });
      expect(result.blockingUnavailable).toBe(true);
    }
  });
});

describe("availability and coverage are not fabricated observed drift or PASS", () => {
  it("reports no baseline and newly added probes while still comparing stable fields", () => {
    const noBaseline = analyze(null, { userAgent: "UA", screenW: 1920 });
    expect(noBaseline).toMatchObject({ risky: false, partial: true, baselineFields: 0, availableFields: 2, comparedFields: 0 });
    expect(noBaseline.changes.every((row) => row.reason === "baseline-missing" && row.severity === "review")).toBe(true);
    const added = analyze({ userAgent: "UA" }, { userAgent: "UA", screenW: 1920 });
    expect(added).toMatchObject({ partial: true, fields: 2, baselineFields: 1, availableFields: 2, comparedFields: 1 });
    expect(added.changes).toEqual([{ field: "screenW", baseline: undefined, current: 1920, availability: "baseline-missing", category: "availability", severity: "review", reason: "probe-added" }]);
    expect(isFingerprintSnapshotEquivalent(null, { userAgent: "UA" })).toBe(false);
  });

  it("marks a previously valid required probe unavailable, not risky, even with a legacy empty diff", () => {
    const baseline = { userAgent: "UA", screenW: 1920, platform: "MacIntel" };
    const current = { userAgent: "UA", platform: "MacIntel" };
    const result = analyzeFingerprintDrift(baseline, current, []);
    expect(result).toMatchObject({ risky: false, partial: true, blockingUnavailable: true, fields: 2, baselineFields: 3, availableFields: 2, comparedFields: 2 });
    expect(result.changes).toEqual([
      { field: "screenW", baseline: 1920, current: undefined, availability: "probe-unavailable", required: true, category: "availability", severity: "unavailable", reason: "probe-unavailable" },
    ]);
    expect(isFingerprintSnapshotEquivalent(baseline, current)).toBe(false);
  });

  it.each([null, "", "800", false, 0, -1, NaN, Infinity, undefined])("does not coerce an invalid height sample %s into normal window geometry", (current) => {
    const result = analyze({ innerHeight: 800 }, { innerHeight: current });
    expect(result.changes[0]).toMatchObject({ baseline: 800, current, availability: "invalid", required: true, severity: "unavailable" });
    expect(result).toMatchObject({ risky: false, partial: true, blockingUnavailable: true });
    expect(isFingerprintSnapshotEquivalent({ innerHeight: 800 }, { innerHeight: current })).toBe(false);
  });

  it("keeps missing, null, empty plugin tables and scalar types distinct", () => {
    expect(diffFingerprintSnapshots({ plugins: "" }, {})).toEqual([
      { field: "plugins", baseline: "", current: undefined, availability: "probe-unavailable", required: true },
    ]);
    expect(diffFingerprintSnapshots({ plugins: "" }, { plugins: null })).toEqual([
      { field: "plugins", baseline: "", current: null, availability: "invalid", required: true },
    ]);
    expect(diffFingerprintSnapshots({}, { plugins: "" })).toEqual([
      { field: "plugins", baseline: undefined, current: "", availability: "baseline-missing" },
    ]);
    expect(diffFingerprintSnapshots({ futureValue: 0 }, { futureValue: false })).toEqual([{ field: "futureValue", baseline: 0, current: false }]);
    expect(diffFingerprintSnapshots({ futureValue: 1 }, { futureValue: "1" })).toEqual([{ field: "futureValue", baseline: 1, current: "1" }]);
    expect(diffFingerprintSnapshots({ maxTouchPoints: 0 }, { maxTouchPoints: false })[0]).toMatchObject({ availability: "invalid" });
    expect(isFingerprintSnapshotEquivalent({ plugins: "" }, { plugins: "" })).toBe(true); // Persona is a separate, explicit conflict.
  });

  it.each([{ error: true }, { error: "worker failed" }, { timeout: true }, { unsupported: true }, { supported: false }])("keeps identical optional Worker markers incomplete: %j", (marker) => {
    const fp = { userAgent: "UA", workerIdentity: json(marker) };
    const result = analyze(fp, fp);
    expect(result).toMatchObject({ risky: false, partial: true, blockingUnavailable: false, fields: 2, baselineFields: 2, availableFields: 1, comparedFields: 1 });
    expect(result.changes[0]).toMatchObject({ field: "workerIdentity", severity: "unavailable", availability: "probe-unavailable" });
    expect(isFingerprintSnapshotEquivalent(fp, fp)).toBe(false);
    const formerlyValid = analyze({ userAgent: "UA", workerIdentity: json({ platform: "MacIntel" }) }, fp);
    expect(formerlyValid).toMatchObject({ risky: false, partial: true, blockingUnavailable: false });
  });

  it("does not turn optional unsupported APIs or a missing Worker into a green confirmation", () => {
    const unsupported = { userAgent: "UA", uaPlatform: null, workerIdentity: json({ platform: "MacIntel", glRenderer: null }) };
    const result = analyze(unsupported, unsupported);
    expect(result).toMatchObject({ risky: false, partial: true, blockingUnavailable: false });
    expect(result.counts.unavailable).toBe(2);
    expect(isFingerprintSnapshotEquivalent(unsupported, unsupported)).toBe(false);
    const baseline = { userAgent: "UA", workerIdentity: json({ platform: "MacIntel" }) };
    expect(analyze(baseline, { userAgent: "UA" })).toMatchObject({ partial: true, blockingUnavailable: false });
  });

  it("distinguishes a missing/invalid baseline leaf from an unavailable current leaf", () => {
    const baseline = { uaHighEntropy: json({ architecture: "arm", bitness: "64" }), userAgent: "UA" };
    const missingCurrent = analyze(baseline, { ...baseline, uaHighEntropy: json({ architecture: "arm" }) });
    expect(missingCurrent.changes[0]).toMatchObject({ field: "uaHighEntropy.bitness", availability: "probe-unavailable", required: true });
    expect(missingCurrent.blockingUnavailable).toBe(true);
    const added = analyze({ uaHighEntropy: json({ architecture: "arm" }) }, { uaHighEntropy: json({ architecture: "arm", bitness: "64" }) });
    expect(added.changes[0]).toMatchObject({ availability: "baseline-missing", severity: "review", reason: "probe-added" });
    const invalidBaseline = analyze({ screenW: "1920", userAgent: "UA" }, { screenW: 1920, userAgent: "UA" });
    expect(invalidBaseline).toMatchObject({ risky: false, partial: true, blockingUnavailable: false, comparedFields: 1 });
  });

  it("does not claim stability for empty snapshots", () => {
    for (const baseline of [null, undefined, {}]) {
      expect(analyze(baseline, {})).toMatchObject({ partial: true, comparedFields: 0 });
      expect(isFingerprintSnapshotEquivalent(baseline, {})).toBe(false);
    }
  });
});

describe("owned browser-version evidence, not broad digit normalization", () => {
  const baseline = chromium("145.0.1.2");
  const current = chromium("146.0.2.3");
  const options = { expectedBrowserVersion: "146.0.2.3" };

  it("reviews only version leaves after current UA and UAHE agree with the owned selected binary", () => {
    const result = analyze(baseline, current, options);
    expect(result).toMatchObject({ risky: false, partial: false });
    expect(result.counts).toEqual({ risk: 0, review: 7, info: 0, unavailable: 0 });
    expect(result.changes.every((row) => row.reason === "browser-version")).toBe(true);
    expect(classifyFingerprintDrift(result.drift[0]).severity).toBe("risk"); // Row-only callers have no launch proof.
    expect(isFingerprintSnapshotEquivalent(baseline, current)).toBe(false); // Update review is still required.
  });

  it.each([undefined, null, "", "146", "147.0.2.3", "Chrome/146.0.2.3"])("does not waive version drift without matching actual evidence: %s", (expectedBrowserVersion) => {
    expect(analyze(baseline, current, { expectedBrowserVersion }).risky).toBe(true);
  });

  it("accepts reduced Chrome UA only with full current UAHE version evidence", () => {
    const reduced = { ...current, userAgent: ua("146.0.0.0"), appVersion: ua("146.0.0.0").slice("Mozilla/".length), workerIdentity: json({ userAgent: ua("146.0.0.0"), platform: "MacIntel", languages: "en-US,en", hardwareConcurrency: 8, tz: "UTC", tzOffset: 0 }) };
    expect(analyze(baseline, reduced, options).risky).toBe(false);
    const { uaHighEntropy: _ignored, ...missing } = reduced;
    expect(analyze(baseline, missing, options).risky).toBe(true);
    const mismatched = JSON.parse(current.uaHighEntropy as string);
    mismatched.fullVersionList[1].version = "147.0.2.3";
    expect(analyze(baseline, { ...current, uaHighEntropy: json(mismatched) }, options).risky).toBe(true);
    expect(analyze(baseline, { ...current, userAgent: ua("147.0.0.0") }, options).risky).toBe(true);
    expect(analyze(baseline, { ...current, userAgent: ua("146.0.2.3suffix") }, options).risky).toBe(true);
  });

  it("requires explicit unsupported-UAHE evidence, not merely a missing probe", () => {
    expect(analyze({ userAgent: ua("145.0.1.2") }, { userAgent: ua("146.0.2.3") }, options).risky).toBe(true);
    const result = analyze({ userAgent: ua("145.0.1.2"), uaPlatform: null }, { userAgent: ua("146.0.2.3"), uaPlatform: null }, options);
    expect(result.changes.find((row) => row.field === "userAgent")).toMatchObject({ severity: "review", reason: "browser-version" });
    expect(result.partial).toBe(true); // Unsupported Client Hints are not a whole-snapshot PASS.
    const firefox = analyze(
      { userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/145.0", uaPlatform: null },
      { userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/146.0", uaPlatform: null },
      { expectedBrowserVersion: "146.0" },
    );
    expect(firefox.changes.find((row) => row.field === "userAgent")).toMatchObject({ severity: "review", reason: "browser-version" });
  });

  it("preserves architecture, OS-token, worker, unknown and GREASE changes alongside a proved browser update", () => {
    const he = JSON.parse(current.uaHighEntropy as string);
    const oldHe = JSON.parse(baseline.uaHighEntropy as string);
    const result = analyze(
      { ...baseline, uaHighEntropy: json({ ...oldHe, futureModel: "A" }) },
      { ...current, uaHighEntropy: json({ ...he, architecture: "x86", futureModel: "B", brands: [{ brand: "Not_A Brand", version: "8" }, ...he.brands.slice(1)] }),
        workerIdentity: json({ ...JSON.parse(current.workerIdentity as string), platform: "Win32" }) },
      options,
    );
    expect(result.changes.find((row) => row.field === "uaHighEntropy.architecture")).toMatchObject({ baseline: "arm", current: "x86", severity: "risk", reason: "identity-changed" });
    expect(result.changes.find((row) => row.field.includes('brands["Not_A Brand"].version'))).toMatchObject({ severity: "risk", reason: "identity-changed" });
    expect(result.changes.find((row) => row.field === "workerIdentity.platform")).toMatchObject({ severity: "risk" });
    expect(result.changes.find((row) => row.field === "uaHighEntropy.futureModel")).toMatchObject({ severity: "review", reason: "unknown-field" });
    const osChanged = analyze(baseline, { ...current, userAgent: ua("146.0.2.3").replace("10_15_7", "11_0_0") }, options);
    expect(osChanged.changes.find((row) => row.field === "userAgent")).toMatchObject({ severity: "risk", reason: "identity-changed" });
  });
});

describe("timezone, persona and confirmation fencing", () => {
  it("reviews offset-only differences without claiming DST from the current date alone", () => {
    const baseline = { tz: "America/New_York", tzOffset: 300 };
    const current = { tz: "America/New_York", tzOffset: 240 };
    const result = analyze(baseline, current, { observedAt: Date.UTC(2026, 6, 1) });
    expect(result.changes).toEqual([{ field: "tzOffset", baseline: 300, current: 240, category: "environment", severity: "review", reason: "timezone-offset" }]);
    expect(isFingerprintSnapshotEquivalent(baseline, current)).toBe(false);
    expect(analyze(baseline, { tz: "Europe/London", tzOffset: 0 }).risky).toBe(true);
    expect(analyze(baseline, { ...current, tz: "Mars/Olympus" })).toMatchObject({ partial: true, blockingUnavailable: true });
  });

  it("never accepts caller-added persona conflicts or lets them be lost behind a stable snapshot", () => {
    const fp = { platform: "MacIntel" };
    const persona: FingerprintDrift = { field: "persona.plugins", baseline: "non-empty (desktop)", current: "empty" };
    const rows = Object.freeze([Object.freeze(persona)]);
    const before = json(rows);
    expect(analyzeFingerprintDrift(fp, fp, rows as FingerprintDrift[])).toMatchObject({ risky: true, counts: { risk: 1 } });
    expect(classifyFingerprintDrift({ ...persona, availability: "invalid" }).severity).toBe("risk");
    expect(isFingerprintSnapshotEquivalent({ ...fp, "persona.plugins": "empty" }, { ...fp, "persona.plugins": "empty" })).toBe(false);
    expect(json(rows)).toBe(before);
  });

  it("keeps caller-added unknown rows and cannot be made green by hiding actual risk or missing probes", () => {
    const unknown = { field: "futureProbe", baseline: "A", current: "B" };
    const result = analyzeFingerprintDrift({ screenW: 1920, platform: "MacIntel" }, { screenW: 1280 }, [unknown]);
    expect(result).toMatchObject({ risky: true, partial: true, blockingUnavailable: true });
    expect(result.changes.find((row) => row.field === "futureProbe")).toMatchObject({ severity: "review", reason: "unknown-field" });
  });
});

describe("bounded, explicit invalid evidence", () => {
  it.each(["", "{bad", "null", "[]", "false", "{}", '"scalar"'])("does not treat identical bad structured values as complete: %s", (value) => {
    const snapshot = { workerIdentity: value, userAgent: "UA" };
    expect(analyze(snapshot, snapshot)).toMatchObject({ risky: false, partial: true, counts: { unavailable: 1 } });
    expect(isFingerprintSnapshotEquivalent(snapshot, snapshot)).toBe(false);
  });

  it("bounds JSON size, recursion and node count and preserves baseline bytes", () => {
    const baseline = Object.freeze({ uaHighEntropy: json({ architecture: "arm" }), userAgent: "UA" });
    const bytes = json(baseline);
    const tooDeep = '{"x":'.repeat(20) + '"end"' + "}".repeat(20);
    const tooManyNodes = json({ x: Array.from({ length: 2100 }, () => 0) });
    for (const value of [" ".repeat(65537), tooDeep, tooManyNodes]) {
      expect(analyze(baseline, { ...baseline, uaHighEntropy: value })).toMatchObject({ partial: true, blockingUnavailable: true, risky: false });
      expect(isFingerprintSnapshotEquivalent(baseline, { ...baseline, uaHighEntropy: value })).toBe(false);
    }
    expect(json(baseline)).toBe(bytes);
  });

  it("throws on changed-row, snapshot-field and aggregate-size overflow rather than truncating a green result", () => {
    const values = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`x${index}`, 1]));
    const changed = Object.fromEntries(Object.keys(values).map((key) => [key, 2]));
    expect(() => diffFingerprintSnapshots({ uaHighEntropy: json(values) }, { uaHighEntropy: json(changed) })).toThrow(/row limit/i);
    expect(() => diffFingerprintSnapshots({}, Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`x${index}`, index])))).toThrow(/field limit/i);
    const tooLarge = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`x${index}`, "x".repeat(65536)]));
    expect(() => diffFingerprintSnapshots({}, tooLarge)).toThrow(/size limit/i);
    expect(isFingerprintSnapshotEquivalent(tooLarge, tooLarge)).toBe(false);
    expect(() => analyzeFingerprintDrift({ userAgent: "UA" }, { userAgent: "UA" }, Array.from({ length: 513 }, (_, index) => ({ field: `x${index}`, baseline: 1, current: 2 })))).toThrow(/row limit/i);
  });

  it("rejects ambiguous flat-versus-semantic paths rather than silently dropping a difference", () => {
    const baseline = { uaHighEntropy: json({ architecture: "arm" }), "uaHighEntropy.architecture": "A" };
    const current = { uaHighEntropy: json({ architecture: "x86" }), "uaHighEntropy.architecture": "B" };
    expect(() => diffFingerprintSnapshots(baseline, current)).toThrow(/ambiguous/i);
    expect(isFingerprintSnapshotEquivalent(baseline, current)).toBe(false);
  });
});
