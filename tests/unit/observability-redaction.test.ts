// R8 P0-1 / P1-7 / P1-8: observability must never hold plaintext secrets in
// memory, logs must be owner-only, and renderer-supplied metric names bounded.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureObservability,
  resetObservabilityForTest,
  log,
  getRecentEvents,
  recordCounter,
  recordTiming,
  setGauge,
  getMetricsSnapshot,
  exportDiagnosticBundle,
  redactSensitive,
} from "../../src/main/services/observability.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-"));
  configureObservability({ dir });
  resetObservabilityForTest();
});
afterEach(() => {
  resetObservabilityForTest();
  configureObservability({ dir: null } as any);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("observability redaction (R8 P0-1)", () => {
  it("redacts secrets before storing in memory (obs:events read-back is safe)", () => {
    const entry = log("info", "test.event", { password: "s3cret", apiKey: "k", nested: { token: "t" }, ok: "visible" });
    expect(entry.password).toBe("[redacted]");
    expect((entry.nested as any).token).toBe("[redacted]");
    expect(entry.ok).toBe("visible");
    const back = getRecentEvents(10);
    expect(back[back.length - 1].password).toBe("[redacted]");
    expect((back[back.length - 1].nested as any).token).toBe("[redacted]");
  });

  it("redacts the extended sensitive key set", () => {
    const out = redactSensitive({ pwd: "a", accessKey: "b", bearer: "c", mnemonic: "d", session: "e", username: "u" }) as any;
    expect(out.pwd).toBe("[redacted]");
    expect(out.accessKey).toBe("[redacted]");
    expect(out.bearer).toBe("[redacted]");
    expect(out.mnemonic).toBe("[redacted]");
    expect(out.session).toBe("[redacted]");
    expect(out.username).toBe("u");
  });

  it("writes log files owner-only (0600)", () => {
    log("info", "test.perm", { x: 1 });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
    expect(files.length).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      for (const f of files) {
        expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("writes diagnostic bundles owner-only (0600)", () => {
    const r = exportDiagnosticBundle({ note: "test" });
    expect(r.success).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(r.filePath!).mode & 0o777).toBe(0o600);
    }
  });
});

describe("metric name bounds (R8 P1-8)", () => {
  it("caps the metric key-space so a hostile renderer cannot grow it", () => {
    for (let i = 0; i < 2000; i++) {
      recordCounter("evil-" + i);
      recordTiming("evil-t-" + i, 1);
      setGauge("evil-g-" + i, 1);
    }
    const snap = getMetricsSnapshot();
    expect(Object.keys(snap.counters).length).toBeLessThanOrEqual(500);
    expect(Object.keys(snap.timings).length).toBeLessThanOrEqual(500);
    expect(Object.keys(snap.gauges).length).toBeLessThanOrEqual(500);
  });

  it("rejects non-finite gauge/timing values", () => {
    setGauge("g", NaN);
    recordTiming("t", Infinity);
    const snap = getMetricsSnapshot();
    expect(snap.gauges["g"]).toBeUndefined();
    expect(snap.timings["t"]).toBeUndefined();
  });
});
