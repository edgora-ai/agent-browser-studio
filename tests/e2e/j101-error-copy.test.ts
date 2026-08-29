// J101: error toasts must be human-readable (UX-3). A profile whose proxy was
// deleted fail-closes on launch; the toast must show the friendly actionable
// copy (zh) instead of the raw "Profile requires proxy ... Refusing to launch"
// exception text. Also guards the contextBridge wrapper never leaking.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j101");

describe("J101 — error copy is human-readable (UX-3)", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("launch failure shows friendly actionable copy, not raw exception text", async () => {
    const dirId = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const created = await api.browser.create({ name: "J101-err", platform: "windows", fingerprintSeed: 4242 });
      (window as any).agentBrowser.switchTab("profiles");
      await (window as any).agentBrowser.loadProfiles();
      return created.dirId;
    });
    expect(dirId).toBeTruthy();

    // A named proxy reference that no longer resolves can only come from the
    // outside (sync merge / external edit), so the test writes it the same way:
    // edit config.json on disk, then reload the config in the app.
    const fs = await import("node:fs");
    const configPath = path.join(USERDATA, "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.browserProfiles[dirId].proxyMode = "named";
    cfg.browserProfiles[dirId].proxyName = "ghost-proxy";
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    await h.page.evaluate(() => (window as any).agentBrowser.loadProfiles());

    await h.page.locator('.profile-card:has-text("J101-err") [data-action="launch"]').click({ timeout: 5000 });
    const toastMsg = h.page.locator('#toast-stack .toast-error .toast-msg').first();
    await toastMsg.waitFor({ state: "visible", timeout: 10000 });
    const text = (await toastMsg.textContent()) || "";
    expect(text).toContain("代理");
    expect(text).not.toMatch(/refusing to launch|Error invoking/i);

    // UX: the error toast carries a shortcut button to the Proxies tab, and
    // clicking it navigates there.
    const actionBtn = h.page.locator('#toast-stack .toast-error .toast-action').first();
    await actionBtn.waitFor({ state: "visible", timeout: 5000 });
    expect(await actionBtn.textContent()).toContain("代理页");
    await actionBtn.click({ timeout: 5000 });
    const activeTab = await h.page.evaluate(() => document.querySelector(".nav-item.active")?.getAttribute("data-tab"));
    expect(activeTab).toBe("proxy");
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
