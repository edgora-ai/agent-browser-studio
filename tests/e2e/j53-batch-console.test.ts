// J53: Batch operations console — status/tag filters, row selection,
// batch assign-proxy, and batch delete from the profiles tab.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";
import { dataTab } from "./helpers/find.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j53");

// Header-based CSV: name,platform,locale,timezone,seed,proxy,webrtc,tags
const BULK_TEXT = [
  "name,platform,locale,timezone,seed,proxy,webrtc,tags",
  "j53-alpha,windows,en-US,America/New_York,21301,,,shop|us",
  "j53-beta,macos,en-US,America/Los_Angeles,21302,,,shop|ca",
  "j53-gamma,windows,en-US,Europe/London,21303,,,ads",
].join("\n");

describe("J53 — batch operations console", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    // A named proxy is available from the start so the batch dropdown includes it.
    await h.page.evaluate(() =>
      (window as any).agentBrowser.api.proxy.add("j53-proxy", { type: "http", host: "127.0.0.1", port: 7801 }));
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  async function namedCards(): Promise<string[]> {
    return h.page.evaluate(() =>
      Array.from(document.querySelectorAll("#profile-list .profile-card .name"))
        .map((el) => (el as HTMLElement).textContent || ""));
  }

  it("imports tagged profiles and renders the batch bar", async () => {
    await dataTab(h.page, "profiles").click({ timeout: 5000 });
    await h.page.waitForTimeout(300);
    await h.page.evaluate(() => (window as any).agentBrowser.bulkImport());
    await h.page.waitForSelector("#dlg-bulk-import[open]", { timeout: 5000 });
    await h.page.locator("#bulk-import-text").fill(BULK_TEXT);
    await h.page.evaluate(() => (window as any).agentBrowser.doBulkImport());
    await h.page.waitForTimeout(2500);

    const profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const names = (profiles || []).map((p: any) => p.name);
    expect(names).toContain("j53-alpha");
    expect(names).toContain("j53-beta");
    expect(names).toContain("j53-gamma");
    const alpha = profiles.find((p: any) => p.name === "j53-alpha");
    expect(alpha.tags).toEqual(["shop", "us"]);

    await h.page.waitForSelector("#profile-batch-bar", { timeout: 5000 });
  }, 40000);

  it("filters by tag and status", async () => {
    await h.page.locator("#profile-tag-filter").fill("shop");
    await h.page.waitForTimeout(500);
    let cards = await namedCards();
    expect(cards.filter((n) => n.startsWith("j53-"))).toEqual(["j53-alpha", "j53-beta"]);

    // Everything is stopped → the running filter yields the filtered empty state.
    await h.page.locator("#profile-status-filter").selectOption("running");
    await h.page.waitForTimeout(500);
    const emptyText = await h.page.locator("#profile-list .empty-state").textContent();
    expect(emptyText).toContain("No profiles match the current filter");

    // Clearing filters restores all three.
    await h.page.evaluate(() => (window as any).agentBrowser.clearProfileFilters());
    await h.page.waitForTimeout(500);
    cards = await namedCards();
    expect(cards.filter((n) => n.startsWith("j53-")).length).toBe(3);
  }, 20000);

  it("selects visible rows and shows the batch action bar", async () => {
    await h.page.locator("#profile-tag-filter").fill("shop");
    await h.page.waitForTimeout(500);
    await h.page.locator("#profile-select-all").check();
    await h.page.waitForTimeout(300);
    const count = (await h.page.textContent("#profile-selected-count")).trim();
    expect(count).toBe("2");
    const barVisible = await h.page.evaluate(() =>
      (document.getElementById("profile-batch-actions") as HTMLElement)?.style.display !== "none");
    expect(barVisible).toBe(true);
  }, 20000);

  it("batch-assigns a proxy to the selected profiles", async () => {
    // Alpha + beta are still selected (selection persists across no filter change).
    await h.page.locator("#batch-assign-proxy").selectOption("j53-proxy");
    await h.page.evaluate(() => (window as any).agentBrowser.batchAssignProxy());
    await h.page.waitForTimeout(800);

    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const dirIds = Object.keys(cfg.browserProfiles || {});
    const assigned = dirIds.filter((d) => cfg.browserProfiles[d].proxyName === "j53-proxy");
    expect(assigned.length).toBe(2);
  }, 30000);

  it("batch-deletes a selected profile", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.clearProfileFilters());
    await h.page.locator("#profile-tag-filter").fill("ads");
    await h.page.waitForTimeout(500);
    await h.page.locator("#profile-select-all").check();
    await h.page.waitForTimeout(300);
    const selected = (await h.page.textContent("#profile-selected-count")).trim();
    expect(selected).toBe("1");
    await h.page.evaluate(() => (window as any).agentBrowser.batchDeleteSelected());
    await h.page.waitForSelector("#dlg-confirm[open]", { timeout: 5000 });
    await h.page.locator('#dlg-confirm button[type="submit"]').click({ timeout: 5000 });
    await h.page.waitForTimeout(1000);

    const profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const names = (profiles || []).map((p: any) => p.name);
    expect(names).not.toContain("j53-gamma");
    expect(names).toContain("j53-alpha");
    expect(names).toContain("j53-beta");
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|7801/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
