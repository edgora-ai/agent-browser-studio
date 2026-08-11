// J35: Pre-launch consistency check (Slice 3). Proves the IPC wiring + the
// block path: a WebRTC-IP-without-proxy profile is flagged as a blocker, and
// with blockOnConsistencyConflict=true the launch is refused (before any
// browser spawn, so no binary needed). Also proves warnings surface.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j35");

async function setConfigFlag(h: TestAppHandle, patch: any) {
  const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
  fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify({ ...cfg, ...patch }, null, 2));
  await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
}

describe("J35 — pre-launch consistency check", () => {
  let h: TestAppHandle;
  let riskyDirId = "";
  let cleanDirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    // Risky: WebRTC IP set, explicitly NO proxy → blocker.
    const r1 = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J35-risky", platform: "windows", fingerprintSeed: 35001, webrtcIp: "203.0.113.9", proxyMode: "none",
    }));
    riskyDirId = r1.dirId;
    // Clean: US tz + en-US, no WebRTC → no findings.
    const r2 = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J35-clean", platform: "windows", fingerprintSeed: 35002, timezone: "America/New_York", locale: "en-US", proxyMode: "none",
    }));
    cleanDirId = r2.dirId;
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("flags the WebRTC-without-proxy profile as a blocker", async () => {
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), riskyDirId);
    expect(res.ok).toBe(false);
    expect(res.blockers.some((b: any) => b.code === "webrtc-no-proxy")).toBe(true);
  });

  it("passes the clean profile with no findings", async () => {
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), cleanDirId);
    expect(res.ok).toBe(true);
    expect(res.warnings).toHaveLength(0);
    expect(res.blockers).toHaveLength(0);
  });

  it("uses cached proxy geo to flag timezone and locale mismatch", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    cfg.proxies["j35-us"] = { type: "http", host: "8.8.8.8", port: 8080 };
    cfg.proxyDetections = {
      ...(cfg.proxyDetections || {}),
      "j35-us": {
        detectedAt: Date.now(),
        success: true,
        exitIp: "8.8.8.8",
        country: "United States",
        countryCode: "US",
        timezone: "America/New_York",
        provider: "fixture",
        latencyMs: 1,
        error: null,
      },
    };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J35-proxy-geo", platform: "windows", fingerprintSeed: 35003,
      timezone: "Asia/Shanghai", locale: "zh-CN", proxyMode: "named", proxyName: "j35-us",
    }));
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), r.dirId);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w: any) => w.code === "proxy-tz")).toBe(true);
    expect(res.warnings.some((w: any) => w.code === "proxy-locale")).toBe(true);
    expect(res.warnings.some((w: any) => w.code === "proxy-tz-mismatch")).toBe(true);
  });

  it("refuses to launch the risky profile when blockOnConsistencyConflict=true", async () => {
    await setConfigFlag(h, { blockOnConsistencyConflict: true });
    // browser:launch catches errors and returns {success:false, error}.
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), riskyDirId);
    expect(res.success, "launch must be refused on a blocker when blocking is enabled").toBe(false);
    expect(res.error).toMatch(/consistency|blocked|WebRTC/i);

    // The blocker was recorded in the audit log.
    const audit = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ category: "profile" }));
    const blocker = audit.find((a: any) => a.action === "consistency-blocker" && a.target === riskyDirId);
    expect(blocker, "blocker must be audited").toBeTruthy();
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|WebRTC|consistency|blocked/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
