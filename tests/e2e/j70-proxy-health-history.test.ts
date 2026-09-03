// J70: Proxy health / history / rotation as managed assets (Slice 44).
// Adds an unreachable proxy (fast-fail detection) plus a fallback, drives the
// Detect -> poor-health -> rotate -> history timeline UI flow, and verifies the
// health row, rotation row and history timeline render from persisted data.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";
import { clickCmd } from "./helpers/find.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j70");
const mainCard = () => '#proxy-list [data-proxy-name="test-proxy"]';

function addProxyViaDialog(page: any, name: string, host: string, port: string, fallbacks?: string): Promise<void> {
  return page.evaluate(() => (window as any).agentBrowser.switchTab("proxy"))
    .then(() => page.waitForTimeout(200))
    .then(() => clickCmd(page, "newProxy"))
    .then(() => page.waitForSelector("#dlg-proxy[open]", { timeout: 5000 }))
    .then(() => page.locator("#dlg-proxy-name").fill(name))
    .then(() => page.locator("#dlg-proxy-type").selectOption("http"))
    .then(() => page.locator("#dlg-proxy-host").fill(host))
    .then(() => page.locator("#dlg-proxy-port").fill(port))
    .then(async () => {
      if (fallbacks) await page.locator("#dlg-proxy-fallbacks").fill(fallbacks);
    })
    .then(() => page.evaluate(() => (window as any).agentBrowser.saveProxy()))
    .then(() => page.waitForTimeout(400));
}

describe("J70 — proxy health/history/rotation managed assets", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("adds an unreachable proxy and a fallback", async () => {
    await addProxyViaDialog(h.page, "test-proxy", "127.0.0.1", "8888", "fallback-a");
    await addProxyViaDialog(h.page, "fallback-a", "127.0.0.1", "7777");
    await h.page.waitForSelector(mainCard(), { timeout: 5000 });
    const exists = await h.page.evaluate(() => document.querySelector('#proxy-list [data-proxy-name="test-proxy"]') !== null);
    expect(exists).toBe(true);
  }, 30000);

  it("detect records a failed health observation (fast-fail on closed port)", async () => {
    await h.page.locator(mainCard() + ' [data-action="detect-proxy"]').click({ timeout: 5000 });
    await h.page.waitForFunction(() => {
      const el = document.querySelector('#proxy-list [data-proxy-name="test-proxy"] .proxy-health-row');
      return el && /❌|分/.test(el.textContent || "");
    }, { timeout: 20000 });
    const healthText = await h.page.textContent(mainCard() + " .proxy-health-row");
    expect(healthText).toMatch(/分/);
  }, 30000);

  it("rotation suggests the healthy fallback and records the switch", async () => {
    await h.page.locator(mainCard() + ' [data-action="rotate-proxy"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(600);
    const rotationText = await h.page.textContent(mainCard() + " .proxy-rotation-text").catch(() => "");
    expect(rotationText).toContain("fallback-a");
  }, 20000);

  it("history timeline expands and shows the failed detection", async () => {
    await h.page.locator(mainCard() + ' [data-action="toggle-history"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    const visible = await h.page.evaluate(() => {
      const row = document.querySelector('#proxy-list [data-proxy-name="test-proxy"] .proxy-history-row') as HTMLElement | null;
      return row ? row.style.display !== "none" : false;
    });
    expect(visible).toBe(true);
    const histText = await h.page.textContent(mainCard() + " .proxy-history-text");
    expect(histText).toContain("❌");
    await h.page.locator(mainCard() + ' [data-action="toggle-history"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(200);
    const collapsed = await h.page.evaluate(() => {
      const row = document.querySelector('#proxy-list [data-proxy-name="test-proxy"] .proxy-history-row') as HTMLElement | null;
      return row ? row.style.display === "none" : true;
    });
    expect(collapsed).toBe(true);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED|8888|7777|curl/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
