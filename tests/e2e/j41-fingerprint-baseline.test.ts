// J41: Fingerprint baseline + drift (Slice 10, P0). Launch a real profile,
// capture its live fingerprint baseline, prove it's stable on re-capture, and
// that a tampered baseline produces detected drift.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j41");

describe("J41 — fingerprint baseline + drift detection", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J41", platform: "windows", fingerprintSeed: 41414 }));
    dirId = r.dirId;
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
    // Wait until running.
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId);
      if (st.running) break;
      await h.page.waitForTimeout(300);
    }
  }, 90000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("captures a baseline with real fingerprint fields", async () => {
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.captureBaseline(id), dirId);
    expect(res.ok).toBe(true);
    expect(res.fields).toBeGreaterThan(3);
    expect(res.baseline.userAgent).toBeTruthy();
    expect(res.drift).toEqual([]);
  }, 30000);

  it("re-capture is stable (no drift) and the baseline persists", async () => {
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.captureBaseline(id), dirId);
    expect(res.ok).toBe(true);
    expect(res.drift).toEqual([]);
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const baseline = cfg.browserProfiles[dirId]?.fingerprintBaseline;
    expect(baseline?.userAgent).toBeTruthy();
  }, 30000);

  it("a tampered baseline produces detected, risky drift", async () => {
    // Tamper the stored baseline so the next capture diffs against a wrong UA.
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    cfg.browserProfiles[dirId].fingerprintBaseline = { ...cfg.browserProfiles[dirId].fingerprintBaseline, userAgent: "TAMPERED-WRONG-UA", tz: "Mars/Olympus" };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.captureBaseline(id), dirId);
    expect(res.ok).toBe(true);
    const fields = res.drift.map((d: any) => d.field);
    expect(fields).toContain("userAgent");
    expect(res.risky).toBe(true);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|TAMPERED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
