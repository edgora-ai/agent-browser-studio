// J94: Proxy exit risk detection (Slice 73). Proves the IDC/hosting and
// public-proxy risk flags flow end to end:
//   - a cached detection with hosting=true surfaces a `proxy-idc` consistency
//     warning (with org/ASN) on the bound profile's launch check;
//   - a hosting=false clean detection does not;
//   - the Proxies tab renders a 🏭 IDC badge from persisted health history and
//     shows the IDC marker in the history timeline.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j94");

function writeConfigFixture(h: TestAppHandle) {
  const cfgPath = userDataConfigPath(USERDATA);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const now = Date.now();
  cfg.proxies = {
    ...(cfg.proxies || {}),
    "idc-proxy": { type: "http", host: "10.0.0.1", port: 8080 },
    "clean-proxy": { type: "http", host: "10.0.0.2", port: 8080 },
  };
  cfg.proxyDetections = {
    ...(cfg.proxyDetections || {}),
    "idc-proxy": {
      detectedAt: now, success: true, exitIp: "152.70.241.120",
      country: "South Korea", countryCode: "KR", timezone: "Asia/Seoul",
      provider: "fixture", latencyMs: 90,
      org: "Oracle Corporation", as: "AS31898", hosting: true, isProxy: false, error: null,
    },
    "clean-proxy": {
      detectedAt: now, success: true, exitIp: "198.51.100.7",
      country: "United States", countryCode: "US", timezone: "America/New_York",
      provider: "fixture", latencyMs: 60,
      org: "Residential ISP", as: "AS701", hosting: false, isProxy: false, error: null,
    },
  };
  const historyPoint = (success: boolean, hosting: boolean, isProxy: boolean, org: string, as: string) => ({
    at: now, success, exitIp: success ? "152.70.241.120" : null, countryCode: "KR",
    timezone: "Asia/Seoul", provider: "fixture", latencyMs: 90,
    isp: org, org, as, hosting, isProxy, error: success ? null : "x",
  });
  cfg.proxyHealth = {
    ...(cfg.proxyHealth || {}),
    "idc-proxy": {
      proxyName: "idc-proxy", firstSeenAt: now, lastCheckedAt: now, lastSuccessAt: now,
      checks: 1, successes: 1, consecutiveFailures: 0, distinctExitIps: ["152.70.241.120"],
      ipDriftCount: 0, geoDriftCount: 0, avgLatencyMs: 90, score: 90, risk: "good",
      history: [historyPoint(true, true, false, "Oracle Corporation", "AS31898")],
      bindings: [], cooldownUntil: null, suggestion: null,
      rotations: 0, lastRotatedAt: null, lastRotatedTo: null,
    },
    "clean-proxy": {
      proxyName: "clean-proxy", firstSeenAt: now, lastCheckedAt: now, lastSuccessAt: now,
      checks: 1, successes: 1, consecutiveFailures: 0, distinctExitIps: ["198.51.100.7"],
      ipDriftCount: 0, geoDriftCount: 0, avgLatencyMs: 60, score: 90, risk: "good",
      history: [historyPoint(true, false, false, "Residential ISP", "AS701")],
      bindings: [], cooldownUntil: null, suggestion: null,
      rotations: 0, lastRotatedAt: null, lastRotatedTo: null,
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
}

describe("J94 — proxy exit risk detection (IDC / public proxy)", () => {
  let h: TestAppHandle;
  let idcDirId = "";
  let cleanDirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    await writeConfigFixture(h);
    const idc = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J94-idc", platform: "windows", fingerprintSeed: 94001,
      timezone: "Asia/Seoul", locale: "ko-KR", proxyMode: "named", proxyName: "idc-proxy",
    }));
    idcDirId = idc.dirId;
    const clean = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J94-clean", platform: "windows", fingerprintSeed: 94002,
      timezone: "America/New_York", locale: "en-US", proxyMode: "named", proxyName: "clean-proxy",
    }));
    cleanDirId = clean.dirId;
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("warns proxy-idc (with org/ASN) on a profile bound to an IDC exit", async () => {
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), idcDirId);
    expect(res.ok).toBe(true);
    const idc = (res.warnings as any[]).find((w) => w.code === "proxy-idc");
    expect(idc).toBeTruthy();
    expect(idc.message).toContain("Oracle Corporation");
    expect(idc.message).toContain("AS31898");
    expect(idc.message.toLowerCase()).toContain("net.isidc");
  }, 15000);

  it("does not flag a clean residential exit as IDC", async () => {
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), cleanDirId);
    expect(res.ok).toBe(true);
    expect((res.warnings as any[]).some((w) => w.code === "proxy-idc")).toBe(false);
    expect((res.warnings as any[]).some((w) => w.code === "proxy-anonymous")).toBe(false);
  }, 15000);

  it("renders the 🏭 IDC badge on the IDC proxy card only", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("proxy"));
    await h.page.waitForSelector('#proxy-list [data-proxy-name="idc-proxy"]', { timeout: 8000 });
    await h.page.waitForSelector('#proxy-list [data-proxy-name="idc-proxy"] .proxy-idc-badge', { timeout: 8000 });
    const idcBadge = await h.page.textContent('#proxy-list [data-proxy-name="idc-proxy"] .proxy-idc-badge');
    expect(idcBadge).toContain("IDC");
    const cleanBadge = await h.page.evaluate(() => {
      const card = document.querySelector('#proxy-list [data-proxy-name="clean-proxy"]');
      return card ? card.querySelectorAll(".proxy-idc-badge").length : -1;
    });
    expect(cleanBadge).toBe(0);
  }, 30000);

  it("shows the IDC marker in the history timeline", async () => {
    await h.page.locator('#proxy-list [data-proxy-name="idc-proxy"] [data-action="toggle-history"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    const hist = await h.page.textContent('#proxy-list [data-proxy-name="idc-proxy"] .proxy-history-text');
    expect(hist).toContain("🏭IDC");
  }, 20000);

  it("no unexpected console errors", () => {
    const errors = filterKnownConsoleErrors(h.consoleErrors);
    expect(errors).toEqual([]);
  });
});
