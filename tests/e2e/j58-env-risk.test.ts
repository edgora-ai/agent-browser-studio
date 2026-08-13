// J58: Host environment risk check (Slice 22). The profile card's Env button
// calls browser:env-risk; a stopped profile gets the pre-launch report (DNS
// resolvers / CN fonts / proxy DNS), a running profile also gets the rAF
// runtime measurement. We assert structure and severity semantics, not the
// host's actual resolver/font makeup.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j58");

describe("J58 — host environment risk check", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J58", platform: "windows", locale: "en-US", timezone: "America/New_York", fingerprintSeed: 91919 }));
    dirId = r.dirId;
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  async function envRisk(): Promise<any> {
    return h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.envRisk(id), dirId);
  }
  async function stop(): Promise<void> {
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId);
      if (!st.running) break;
      await h.page.waitForTimeout(300);
    }
  }

  it("returns a structured pre-launch environment report", async () => {
    const r = await envRisk();
    expect(r.ok).toBe(true);
    const res = r.result;
    expect(res).toBeTruthy();
    expect(Array.isArray(res.resolvers)).toBe(true);
    expect(Array.isArray(res.cnFonts)).toBe(true);
    expect(res.proxy).toBeTruthy();
    expect(["low", "high", "none"]).toContain(res.proxy.dnsLeakRisk);
    expect(res.hostLocale).toBeTruthy();
    expect(Array.isArray(res.findings)).toBe(true);
    for (const f of res.findings) {
      expect(["high", "medium", "info"]).toContain(f.severity);
      expect(typeof f.code).toBe("string");
      expect(typeof f.message).toBe("string");
      expect(typeof f.fix).toBe("string");
    }
    expect(typeof res.ok).toBe("boolean");
  }, 30000);

  it("reports a DNS-leak finding when a CN resolver is present for a non-CN profile", async () => {
    const r = await envRisk();
    const res = r.result;
    const cnResolver = (res.resolvers || []).some((rr: any) => rr.isCn);
    const leak = res.findings.find((f: any) => f.code === "dns-resolver-leak");
    if (cnResolver) {
      expect(leak).toBeTruthy();
      expect(leak.severity).toBe("high");
    } else {
      expect(leak).toBeUndefined();
    }
  }, 30000);

  it("includes the rAF runtime measurement while the profile is running", async () => {
    const launch = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
    expect(launch.success).toBe(true);
    // Give the page a moment to paint.
    await h.page.waitForTimeout(2500);
    const r = await envRisk();
    expect(r.ok).toBe(true);
    expect(r.result).toHaveProperty("raf");
    if (r.result.raf && r.result.raf.samples > 0) {
      expect(typeof r.result.raf.medianMs).toBe("number");
      expect(typeof r.result.raf.refreshHz).toBe("number");
      expect(typeof r.result.raf.standard).toBe("boolean");
    }
    await stop();
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
