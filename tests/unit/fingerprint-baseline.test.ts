import { describe, it, expect } from "vitest";
import { diffFingerprints, hasRiskyDrift, summarizeDrift, CAPTURE_EXPRESSION, checkPersonaConsistency, mismatchesAsDrift } from "../../src/main/services/fingerprint-baseline.js";

describe("fingerprint baseline diff", () => {
  it("returns no drift for identical fingerprints", () => {
    const fp = { userAgent: "X", platform: "Win32", tz: "America/New_York", glRenderer: "ANGLE" };
    expect(diffFingerprints(fp, { ...fp })).toEqual([]);
  });

  it("returns no drift when there is no prior baseline", () => {
    expect(diffFingerprints(null, { userAgent: "X" })).toEqual([]);
    expect(diffFingerprints(undefined, { userAgent: "X" })).toEqual([]);
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

  it("flags risky drift on signal fields", () => {
    expect(hasRiskyDrift([{ field: "userAgent", baseline: "a", current: "b" }])).toBe(true);
    expect(hasRiskyDrift([{ field: "canvasLen", baseline: 1, current: 2 }])).toBe(false);
  });

  it("tolerates ±1px macOS window-server rounding on window-frame fields only", () => {
    const base = { screenY: 32, innerHeight: 800, screenX: 32, innerWidth: 1280, canvasHash: "aa" };
    expect(diffFingerprints(base, { ...base, screenY: 33, innerHeight: 799, screenX: 31, innerWidth: 1281 })).toEqual([]);
    expect(diffFingerprints(base, { ...base, screenY: 34 })).toEqual([
      { field: "screenY", baseline: 32, current: 34 },
    ]);
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

  it("flags newly aligned native surfaces as risky drift", () => {
    for (const field of ["workerIdentity", "webglCapabilityHash", "webgpuVendor", "webgpuCapabilityHash", "fontCapabilityHash", "speechVoices", "mediaDevices", "doNotTrack", "maxTouchPoints", "screenX", "outerWidth", "availTop", "systemColors", "preferredColorScheme"]) {
      expect(hasRiskyDrift([{ field, baseline: "a", current: "b" }]), field).toBe(true);
    }
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

  it("persona mismatches render as drift entries", () => {
    const drift = mismatchesAsDrift([{ field: "persona.platform", expected: "Win32", actual: "MacIntel" }]);
    expect(drift).toEqual([{ field: "persona.platform", baseline: "Win32", current: "MacIntel" }]);
  });
});
