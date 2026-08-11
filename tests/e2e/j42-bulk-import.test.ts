// J42: Bulk CSV import (Slice 11). The header-based CSV parser + UI flow creates
// profiles with per-row proxy binding + tags.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j42");
const CSV = "name,platform,locale,timezone,seed,proxy,tags\nJ42-A,windows,en-US,America/New_York,42111,j42-proxy,shop\nJ42-B,macos,de-DE,Europe/Berlin,42222,,";

describe("J42 — bulk CSV import with proxy binding", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    // A named proxy referenced by a CSV row.
    await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.add("j42-proxy", { type: "http", host: "127.0.0.1", port: 7001 }));
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("imports header-CSV rows and binds a per-row proxy", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForTimeout(300);
    await h.page.evaluate(() => (window as any).agentBrowser.bulkImport());
    await h.page.waitForSelector("#dlg-bulk-import[open]", { timeout: 5000 });
    await h.page.locator("#bulk-import-text").fill(CSV);
    await h.page.evaluate(() => (window as any).agentBrowser.doBulkImport());
    // Wait for the import to finish + dialog to close.
    await h.page.waitForTimeout(2500);

    const profiles = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const a = profiles.find((p: any) => p.name === "J42-A");
    const b = profiles.find((p: any) => p.name === "J42-B");
    expect(a, "J42-A must be imported").toBeTruthy();
    expect(b, "J42-B must be imported").toBeTruthy();
    expect(a.proxyMode).toBe("named");
    expect(a.proxyName).toBe("j42-proxy");
    expect(a.tags).toEqual(["shop"]);
    expect(b.proxyMode).not.toBe("named");
  }, 30000);

  it("renders imported profile tags and exports them", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForFunction(() => document.querySelector("#profile-list")?.textContent?.includes("shop"), null, { timeout: 5000 });
    const listText = await h.page.locator("#profile-list").innerText();
    expect(listText).toContain("SHOP");

    const exported = await h.page.evaluate(() => (window as any).agentBrowser.api.data.export("profiles"));
    expect(exported.ok).toBe(true);
    const a = exported.data.profiles.find((p: any) => p.name === "J42-A");
    expect(a?.tags).toEqual(["shop"]);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|7001/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
