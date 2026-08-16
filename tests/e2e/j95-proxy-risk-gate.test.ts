// J95: Proxy-risk launch gate + DNS routing audit (Slice 74). Proves the
// optional blockOnProxyRisk gate end to end:
//   - with blockOnProxyRisk=true, a profile bound to an IDC exit surfaces a
//     proxy-idc blocker on consistencyCheck and the launch is refused before
//     any browser spawn;
//   - by default the same exit is a warning, not a blocker;
//   - a managed proxy launch records a dns-route audit proving DNS (incl. the
//     DoH probe) is routed through the exit proxy with no host-resolver
//     fallback, keeping the resolver coherent with the exit identity.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { waitForCdpPort } from "./helpers/cdp.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j95");

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
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
}

async function setConfigFlag(h: TestAppHandle, patch: any) {
  const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
  fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify({ ...cfg, ...patch }, null, 2));
  await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
}

describe("J95 — proxy-risk launch gate + DNS routing audit", () => {
  let h: TestAppHandle;
  let idcDirId = "";
  let cleanDirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    await writeConfigFixture(h);
    const idc = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J95-idc", platform: "windows", fingerprintSeed: 95001,
      timezone: "Asia/Seoul", locale: "ko-KR", proxyMode: "named", proxyName: "idc-proxy",
    }));
    idcDirId = idc.dirId;
    const clean = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J95-clean", platform: "windows", fingerprintSeed: 95002,
      timezone: "America/New_York", locale: "en-US", proxyMode: "named", proxyName: "clean-proxy",
    }));
    cleanDirId = clean.dirId;
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("keeps an IDC exit as a warning by default (blockOnProxyRisk unset)", async () => {
    await setConfigFlag(h, { blockOnProxyRisk: false });
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), idcDirId);
    expect(res.ok).toBe(true);
    expect((res.warnings as any[]).some((w) => w.code === "proxy-idc")).toBe(true);
    expect((res.blockers as any[]).some((b) => b.code === "proxy-idc")).toBe(false);
  }, 15000);

  it("escalates an IDC exit to a blocker and refuses the launch when blockOnProxyRisk=true", async () => {
    await setConfigFlag(h, { blockOnProxyRisk: true });
    const res = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.consistencyCheck(id), idcDirId);
    expect(res.ok).toBe(false);
    const blocker = (res.blockers as any[]).find((b) => b.code === "proxy-idc");
    expect(blocker).toBeTruthy();
    expect(blocker.message).toContain("Oracle Corporation");

    // Launch is refused before any browser spawn.
    const lr = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), idcDirId);
    expect(lr.success, "launch must be refused on proxy-risk blocker when the gate is on").toBe(false);
    expect(lr.error).toMatch(/consistency|blocked|IDC/i);

    const audit = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ category: "profile" }));
    const blockerAudit = audit.find((a: any) => a.action === "consistency-blocker" && a.target === idcDirId);
    expect(blockerAudit, "proxy-risk blocker must be audited").toBeTruthy();
  }, 30000);

  it("records a dns-route audit on a managed proxy launch", async () => {
    // Clean residential exit passes the gate, so the managed launch proceeds
    // and must prove proxy-coherent DNS routing in the audit trail.
    const lr = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), cleanDirId);
    expect(lr.success, lr.error || "clean proxy launch failed").toBe(true);
    h.cdpPids.push(lr.pid);
    await waitForCdpPort(lr.cdpPort, 15000);

    const audit = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ category: "profile" }));
    const dnsRoute = audit.find((a: any) => a.action === "dns-route" && a.target === cleanDirId);
    expect(dnsRoute, "managed proxy launch must record a dns-route audit").toBeTruthy();
    expect(dnsRoute.detail).toMatch(/proxy DNS active/i);
    expect(dnsRoute.detail).toMatch(/no host-resolver fallback/i);
  }, 90000);

  it("no unexpected console errors", () => {
    const errors = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED|proxy|SOCKS|WebRTC|consistency|blocked/i.test(e));
    expect(errors).toEqual([]);
  });
});
