// J43: Sync pre-flight preview (Slice 13). sync:preview reports the local state
// a push would involve + which running profiles would be skipped on pull — no
// network, no mutation.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j43");

describe("J43 — sync pre-flight preview", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J43", platform: "windows", fingerprintSeed: 43434 }));
    await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.add("j43-proxy", { type: "http", host: "127.0.0.1", port: 7043 }));
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("reports counts + running-skip list + configured state", async () => {
    const p = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.preview());
    expect(p.profiles).toBeGreaterThanOrEqual(1);
    expect(p.proxies).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(p.runningProfiles)).toBe(true);
    // Nothing running in this test → empty skip list.
    expect(p.runningProfiles.length).toBe(0);
    expect(p.configured).toBe(false); // no endpoint/bucket configured
    expect(p.message).toBeTruthy();
  }, 30000);

  async function launchRunningProfile(name: string, seed: number): Promise<string> {
    const r = await h.page.evaluate(async (p: { name: string; seed: number }) => (window as any).agentBrowser.api.browser.create({ name: p.name, platform: "windows", fingerprintSeed: p.seed }), { name, seed });
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), r.dirId);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), r.dirId);
      if (st.running) return r.dirId;
      await h.page.waitForTimeout(300);
    }
    throw new Error(`profile did not start: ${r.dirId}`);
  }

  it("flags a running profile that pull would skip", async () => {
    const dirId = await launchRunningProfile("J43-run", 43999);
    const p = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.preview());
    expect(p.runningProfiles).toContain(dirId);
    expect(p.message).toContain("跳过");
  }, 40000);

  it("renders preview in the Sync tab", async () => {
    const dirId = await launchRunningProfile("J43-ui", 43997);
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("sync"));
    await h.page.evaluate(() => (window as any).agentBrowser.loadSyncPreview());
    await h.page.waitForFunction((id: string) => {
      const msg = document.getElementById("sync-preview-message")?.textContent || "";
      const list = document.getElementById("sync-preview")?.textContent || "";
      return msg.includes("跳过") && list.includes(id);
    }, dirId, { timeout: 5000 });
    const previewText = await h.page.locator("#sync-preview").innerText();
    expect(previewText).toContain("Profiles");
    expect(previewText).toContain("Proxies");
    expect(previewText).toContain("Accounts");
    expect(previewText).toContain("Extensions");
    expect(previewText).toContain(dirId);
    const message = await h.page.locator("#sync-preview-message").innerText();
    expect(message).toMatch(/同步未配置|将同步/);
    expect(message).toContain("跳过");
  }, 40000);

  it("prompts before pull when running profiles would be skipped", async () => {
    await launchRunningProfile("J43-prompt", 43998);
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("sync"));
    const dialogPromise = new Promise<string>((resolve) => {
      h.page.once("dialog", async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        resolve(message);
      });
    });
    await h.page.locator('[data-cmd="syncPull"]').click();
    const dialogMessage = await dialogPromise;
    expect(dialogMessage).toContain("运行中 profile");
    expect(dialogMessage).toContain("跳过");
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|7043|7050/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
