// J29: Proxy tab — manual UI CRUD. Opens the Add Proxy dialog, fills the form,
// saves, verifies the card; sets it default; edits; deletes — all via the real
// card buttons (data-action) scoped to the test-proxy card. Deletion uses the
// custom #dlg-confirm dialog (not window.confirm).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j29");
const card = () => '#proxy-list [data-proxy-name="test-proxy"]';

describe("J29 — proxy tab UI CRUD", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("adds a proxy through the Add Proxy dialog", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("proxy"));
    await h.page.waitForTimeout(300);
    await h.page.locator('[data-cmd="newProxy"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy[open]", { timeout: 5000 });
    await h.page.locator("#dlg-proxy-name").fill("test-proxy");
    await h.page.locator("#dlg-proxy-type").selectOption("http");
    await h.page.locator("#dlg-proxy-host").fill("127.0.0.1");
    await h.page.locator("#dlg-proxy-port").fill("8888");
    await h.page.evaluate(() => (window as any).agentBrowser.saveProxy());
    await h.page.waitForTimeout(400);
    // The test-proxy card is present (other default entries may also exist).
    await h.page.waitForSelector(card(), { timeout: 5000 });
    const exists = await h.page.evaluate(() => document.querySelector('#proxy-list [data-proxy-name="test-proxy"]') !== null);
    expect(exists).toBe(true);
    // Health row renders with an untested state for a proxy with no history.
    const healthText = await h.page.textContent(`${card()} .proxy-health-row`);
    expect(healthText).toContain("未检测");
  }, 20000);

  it("sets the proxy as default via the card button", async () => {
    await h.page.locator(`${card()} [data-action="default-proxy"]`).click({ timeout: 5000 });
    await h.page.waitForTimeout(400);
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    expect(cfg.defaultProxy).toBe("test-proxy");
  }, 20000);

  it("edits the proxy port via the card button", async () => {
    await h.page.locator(`${card()} [data-action="edit-proxy"]`).click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy[open]", { timeout: 5000 });
    await h.page.locator("#dlg-proxy-port").fill("9999");
    await h.page.evaluate(() => (window as any).agentBrowser.saveProxy());
    await h.page.waitForTimeout(400);
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    expect(cfg.proxies["test-proxy"].port).toBe(9999);
  }, 20000);

  it("deletes the proxy via the card button + the confirm dialog", async () => {
    await h.page.locator(`${card()} [data-action="delete-proxy"]`).click({ timeout: 5000 });
    // Custom confirm dialog opens; click its Confirm submit button.
    await h.page.waitForSelector("#dlg-confirm[open]", { timeout: 5000 });
    await h.page.locator('#dlg-confirm button[type="submit"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(500);
    const gone = await h.page.evaluate(() => document.querySelector('#proxy-list [data-proxy-name="test-proxy"]') === null);
    expect(gone, "test-proxy card must be gone after delete").toBe(true);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED|8888|9999/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
