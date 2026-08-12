// J52: Proxy health rotation — fallback config via the dialog, health-state
// injection, rotation-info IPC, manual rotate (audit + counters), UI badge.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j52");

describe("J52 — proxy health rotation", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  async function addProxyViaDialog(name: string, port: string, fallbacks: string) {
    await h.page.locator('[data-cmd="newProxy"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy[open]", { timeout: 5000 });
    await h.page.locator("#dlg-proxy-name").fill(name);
    await h.page.locator("#dlg-proxy-type").selectOption("http");
    await h.page.locator("#dlg-proxy-host").fill("127.0.0.1");
    await h.page.locator("#dlg-proxy-port").fill(port);
    await h.page.locator("#dlg-proxy-fallbacks").fill(fallbacks);
    await h.page.evaluate(() => (window as any).agentBrowser.saveProxy());
    await h.page.waitForTimeout(400);
  }

  it("adds a proxy with a fallback through the dialog", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("proxy"));
    await h.page.waitForTimeout(300);
    await addProxyViaDialog("backup", "9002", "");
    await addProxyViaDialog("primary", "9001", "backup");
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    expect(cfg.proxies["primary"].fallbacks).toEqual(["backup"]);
    await h.page.waitForSelector('#proxy-list [data-proxy-name="primary"]', { timeout: 5000 });
    const hasBackup = await h.page.evaluate(() => {
      const card = document.querySelector('#proxy-list [data-proxy-name="primary"]');
      return card ? card.textContent.includes("备用") && card.textContent.includes("backup") : false;
    });
    expect(hasBackup).toBe(true);
  }, 30000);

  it("rotates to the fallback when the primary becomes unhealthy", async () => {
    const cfgPath = userDataConfigPath(USERDATA);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.proxyHealth = cfg.proxyHealth || {};
    cfg.proxyHealth["primary"] = {
      proxyName: "primary",
      firstSeenAt: Date.now(),
      lastCheckedAt: Date.now(),
      lastSuccessAt: null,
      checks: 3,
      successes: 0,
      consecutiveFailures: 3,
      distinctExitIps: [],
      ipDriftCount: 0,
      geoDriftCount: 0,
      avgLatencyMs: null,
      score: 0,
      risk: "poor",
      history: [],
      bindings: [],
      cooldownUntil: Date.now() + 60_000,
      suggestion: "连续失败",
      rotations: 0,
      lastRotatedAt: null,
      lastRotatedTo: null,
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    await h.page.waitForTimeout(300);

    const info = await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.rotationInfo("primary"));
    expect(info.success).toBe(true);
    expect(info.info.active).toBe(true);
    expect(info.info.to).toBe("backup");
    expect(info.info.reason).toContain("冷却");

    const rotated = await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.rotate("primary"));
    expect(rotated.info.to).toBe("backup");
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg2.proxyHealth["primary"].rotations).toBe(1);
    expect(cfg2.proxyHealth["primary"].lastRotatedTo).toBe("backup");

    await h.page.evaluate(() => (window as any).agentBrowser.refresh());
    await h.page.waitForTimeout(600);
    const rotationText = await h.page.evaluate(() => {
      const row = document.querySelector('#proxy-list [data-proxy-name="primary"] .proxy-rotation-text');
      return row ? row.textContent : "";
    });
    expect(rotationText).toContain("backup");
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED|9001|9002/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
