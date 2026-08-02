import { describe, it, expect } from "vitest";
import { diffFingerprints, hasRiskyDrift, CAPTURE_EXPRESSION } from "../../src/main/services/fingerprint-baseline.js";

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

  it("the capture expression is a self-contained IIFE returning JSON", () => {
    expect(CAPTURE_EXPRESSION).toMatch(/^\(async function\(\)/);
    expect(CAPTURE_EXPRESSION).toContain("userAgent");
    expect(CAPTURE_EXPRESSION).toContain("glRenderer");
    expect(CAPTURE_EXPRESSION).toContain("workerIdentity");
    expect(CAPTURE_EXPRESSION).toContain("webgpuVendor");
    expect(CAPTURE_EXPRESSION).toContain("speechVoices");
    expect(CAPTURE_EXPRESSION).toContain("outerWidth");
    expect(CAPTURE_EXPRESSION).toContain("availTop");
    expect(CAPTURE_EXPRESSION).toContain("return JSON.stringify");
    expect(() => new Function(`return ${CAPTURE_EXPRESSION}`)).not.toThrow();
  });

  it("flags newly aligned native surfaces as risky drift", () => {
    for (const field of ["workerIdentity", "webgpuVendor", "speechVoices", "mediaDevices", "doNotTrack", "maxTouchPoints", "screenX", "outerWidth", "availTop"]) {
      expect(hasRiskyDrift([{ field, baseline: "a", current: "b" }]), field).toBe(true);
    }
  });
});
