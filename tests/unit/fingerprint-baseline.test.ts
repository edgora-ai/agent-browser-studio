import { describe, it, expect } from "vitest";
import { diffFingerprints, hasRiskyDrift, summarizeDrift, CAPTURE_EXPRESSION, sanitizePortableFingerprintBaseline, checkPersonaConsistency, mismatchesAsDrift } from "../../src/main/services/fingerprint-baseline.js";

describe("fingerprint baseline diff", () => {
  it("returns no drift for identical fingerprints", () => {
    const fp = { userAgent: "X", platform: "Win32", tz: "America/New_York", glRenderer: "ANGLE" };
    expect(diffFingerprints(fp, { ...fp })).toEqual([]);
  });

  it("does not claim stability without a prior baseline", () => {
    for (const baseline of [null, undefined]) {
      expect(diffFingerprints(baseline, { userAgent: "X" })).toEqual([
        { field: "userAgent", baseline: undefined, current: "X", availability: "baseline-missing" },
      ]);
    }
  });

  it("detects a changed field", () => {
    const base = { userAgent: "A", platform: "Win32" };
    const cur = { userAgent: "B", platform: "Win32" };
    const d = diffFingerprints(base, cur);
    expect(d.length).toBe(1);
    expect(d[0]).toEqual({ field: "userAgent", baseline: "A", current: "B" });
  });

  it("detects multiple changed fields + new fields", () => {
    const d = diffFingerprints({ userAgent: "A", tz: "X" }, { userAgent: "A", tz: "Y", glRenderer: "R" });
    const fields = d.map((x) => x.field).sort();
    expect(fields).toEqual(["glRenderer", "tz"]);
  });

  it("flags valid seeded signal changes as risk, including canvas length", () => {
    expect(hasRiskyDrift([{ field: "userAgent", baseline: "a", current: "b" }])).toBe(true);
    expect(hasRiskyDrift([{ field: "canvasLen", baseline: 1, current: 2 }])).toBe(true);
  });

  it("keeps normal geometry visible without confusing unavailable probes with observed identity drift", () => {
    for (const field of ["innerWidth", "innerHeight", "outerWidth", "outerHeight", "screenX", "screenY", "availW", "availH", "availLeft", "availTop"]) {
      const changed = diffFingerprints({ [field]: 713 }, { [field]: 600 });
      expect(changed).toEqual([{ field, baseline: 713, current: 600 }]);
      expect(hasRiskyDrift(changed), field).toBe(false);
    }
    for (const current of [null, 0, -1, "600", Number.NaN]) {
      const changed = diffFingerprints({ innerHeight: 713 }, { innerHeight: current });
      expect(changed[0]).toMatchObject({ field: "innerHeight", availability: "invalid", required: true });
      expect(hasRiskyDrift(changed)).toBe(false);
    }
    for (const field of ["screenW", "screenH", "devicePixelRatio"]) {
      expect(hasRiskyDrift([{ field, baseline: 713, current: 600 }]), field).toBe(true);
    }
  });

  it("retains even one-pixel frame differences for audit without treating them as identity changes", () => {
    const base = { screenY: 32, innerHeight: 800, screenX: 32, innerWidth: 1280, canvasHash: "aa" };
    const changed = diffFingerprints(base, { ...base, screenY: 33, innerHeight: 799, screenX: 31, innerWidth: 1281 });
    expect(changed).toEqual([
      { field: "screenY", baseline: 32, current: 33 },
      { field: "innerHeight", baseline: 800, current: 799 },
      { field: "screenX", baseline: 32, current: 31 },
      { field: "innerWidth", baseline: 1280, current: 1281 },
    ]);
    expect(hasRiskyDrift(changed)).toBe(false);
    expect(diffFingerprints(base, { ...base, canvasHash: "bb" })).toEqual([
      { field: "canvasHash", baseline: "aa", current: "bb" },
    ]);
  });

  it("the capture expression is a self-contained IIFE returning JSON", () => {
    expect(CAPTURE_EXPRESSION).toMatch(/^\(async function\(\)/);
    expect(CAPTURE_EXPRESSION).toContain("userAgent");
    expect(CAPTURE_EXPRESSION).toContain("glRenderer");
    expect(CAPTURE_EXPRESSION).toContain("webglCapabilityHash");
    expect(CAPTURE_EXPRESSION).toContain("workerIdentity");
    expect(CAPTURE_EXPRESSION).toContain("webgpuVendor");
    expect(CAPTURE_EXPRESSION).toContain("webgpuCapabilityHash");
    expect(CAPTURE_EXPRESSION).toContain("fontCapabilityHash");
    expect(CAPTURE_EXPRESSION).toContain("speechVoices");
    expect(CAPTURE_EXPRESSION).toContain("systemColors");
    expect(CAPTURE_EXPRESSION).toContain("preferredColorScheme");
    expect(CAPTURE_EXPRESSION).toContain("outerWidth");
    expect(CAPTURE_EXPRESSION).toContain("availTop");
    expect(CAPTURE_EXPRESSION).toContain("return JSON.stringify");
    expect(() => new Function(`return ${CAPTURE_EXPRESSION}`)).not.toThrow();
  });

  it("keeps every field produced by the live capture in a portable baseline", () => {
    const fields = [...new Set(Array.from(CAPTURE_EXPRESSION.matchAll(/\bo\.([a-zA-Z]\w*)\s*=/g), (match) => match[1]))];
    expect(fields.length).toBeGreaterThan(40);
    // The producer's payload shape is flat scalars; JSON-encoded sub-signatures
    // remain strings rather than being interpreted as nested configuration.
    const captured = Object.fromEntries(fields.map((name) => [name, `synthetic-${name}`]));
    expect(sanitizePortableFingerprintBaseline(captured)).toEqual(captured);
    expect(sanitizePortableFingerprintBaseline({ ...captured, otherDevicePath: { path: "/private/secret" } })).toEqual(captured);
    expect(() => sanitizePortableFingerprintBaseline({ workerIdentity: { userAgent: "nested" } })).toThrow(/baseline field/i);
  });

  it("preserves native identity invariants without hard-blocking environmental observations", () => {
    for (const field of ["webglCapabilityHash", "webgpuVendor", "webgpuCapabilityHash", "fontCapabilityHash", "fontAvailability", "audioHash", "plugins", "mimeTypes"]) {
      expect(hasRiskyDrift([{ field, baseline: "a", current: "b" }]), field).toBe(true);
    }
    expect(hasRiskyDrift(diffFingerprints({ maxTouchPoints: 0 }, { maxTouchPoints: 1 }))).toBe(true);
    expect(hasRiskyDrift(diffFingerprints(
      { workerIdentity: JSON.stringify({ platform: "MacIntel" }) },
      { workerIdentity: JSON.stringify({ platform: "Win32" }) },
    ))).toBe(true);
    for (const field of ["speechVoices", "mediaDevices", "doNotTrack"]) {
      expect(hasRiskyDrift([{ field, baseline: "a", current: "b" }]), field).toBe(false);
    }
    expect(hasRiskyDrift(diffFingerprints({ preferredColorScheme: "light" }, { preferredColorScheme: "dark" }))).toBe(false);
    expect(hasRiskyDrift(diffFingerprints(
      { systemColors: JSON.stringify({ Canvas: "rgb(255, 255, 255)" }) },
      { systemColors: JSON.stringify({ Canvas: "rgb(0, 0, 0)" }) },
    ))).toBe(false);
  });

  it("compares JSON identity leaves semantically and preserves the stored baseline bytes", () => {
    const baseline = {
      uaHighEntropy: '{"architecture":"arm","bitness":"64"}',
      workerIdentity: '{"platform":"MacIntel","languages":"en-US,en"}',
    };
    const before = JSON.stringify(baseline);
    expect(diffFingerprints(baseline, {
      uaHighEntropy: '{"bitness":"64","architecture":"arm"}',
      workerIdentity: '{"languages":"en-US,en","platform":"MacIntel"}',
    })).toEqual([]);
    expect(diffFingerprints(baseline, { ...baseline, uaHighEntropy: '{"bitness":"64","architecture":"x86"}' })).toEqual([
      { field: "uaHighEntropy.architecture", baseline: "arm", current: "x86" },
    ]);
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it("summarizes drifted fields (capped)", () => {
    const drift = [
      { field: "userAgent", baseline: "a", current: "b" },
      { field: "tz", baseline: "a", current: "b" },
      { field: "glRenderer", baseline: "a", current: "b" },
    ];
    expect(summarizeDrift(drift)).toBe("userAgent, tz, glRenderer");
    expect(summarizeDrift([])).toBe("none");
  });

  it("summarizeDrift caps long drift lists", () => {
    const drift = Array.from({ length: 12 }, (_, i) => ({ field: "f" + i, baseline: "a", current: "b" }));
    expect(summarizeDrift(drift, 5)).toBe("f0, f1, f2, f3, f4 (+7 more)");
  });

  it("persona consistency passes a coherent Android capture", () => {
    const mismatches = checkPersonaConsistency(
      { platform: "android", timezone: "Asia/Shanghai" },
      {
        platform: "Linux armv81", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) ... Mobile Safari/537.36",
        plugins: "", tz: "Asia/Shanghai",
      },
    );
    expect(mismatches).toEqual([]);
  });

  it("persona consistency flags a host-platform leak that drift would miss", () => {
    const mismatches = checkPersonaConsistency(
      { platform: "windows", timezone: "Asia/Shanghai" },
      {
        platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...",
        plugins: "Internal PDF Plugin, Widevine Content Decryption Module", tz: "America/Los_Angeles",
      },
    );
    expect(mismatches.map((m) => m.field)).toEqual(["persona.platform", "persona.tz"]);
    expect(mismatches[0]).toEqual({ field: "persona.platform", expected: "Win32", actual: "MacIntel" });
  });

  it("persona consistency flags lost plugin injection on desktop + mobile token leak", () => {
    const mobile = checkPersonaConsistency({ platform: "android" }, {
      platform: "Linux armv81", userAgent: "Mozilla/5.0 (Linux; Android 13; ...) Mobile Safari/537.36",
      plugins: "Internal PDF Plugin", tz: "",
    });
    expect(mobile.map((m) => m.field)).toEqual(["persona.plugins"]);
    const desktop = checkPersonaConsistency({ platform: "windows" }, {
      platform: "Win32", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) ... Mobile Safari/537.36",
      plugins: "", tz: "",
    });
    expect(desktop.map((m) => m.field)).toEqual(["persona.plugins", "persona.uaMobile"]);
  });

  it("does not fabricate an empty desktop plugin table from a missing or invalid probe", () => {
    const persona = { platform: "windows" };
    for (const current of [{}, { plugins: null }, { plugins: 0 }]) {
      expect(checkPersonaConsistency(persona, current)).toEqual([]);
    }
    expect(checkPersonaConsistency(persona, { plugins: "" })).toEqual([
      { field: "persona.plugins", expected: "non-empty (desktop)", actual: "empty" },
    ]);
  });

  it("persona mismatches render as drift entries and are always classified as risk", () => {
    const drift = mismatchesAsDrift([{ field: "persona.platform", expected: "Win32", actual: "MacIntel" }]);
    expect(drift).toEqual([{ field: "persona.platform", baseline: "Win32", current: "MacIntel" }]);
    expect(hasRiskyDrift(drift)).toBe(true);
  });
});
