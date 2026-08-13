// J77: Bulk import accounts → bulk create bound profiles (Slice 54 —
// RoxyBrowser 3.8.9 "template bulk import → bulk create profiles" workflow).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j77");

describe("J77 — bulk import → bulk create profiles", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 90000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("creates a bound profile per account from pasted text", async () => {
    const r: any = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.bulkCreate(
      "https://twitter.com, alice, s3cret, social\nhttps://amazon.com, bob, hunter2\n, bad_line, x",
      { platform: "windows" },
    ));
    // Malformed lines are filtered at parse time, so skipped stays 0
    // and the bad line never becomes a profile+account pair.
    expect(r.added).toBe(2);
    expect(r.created).toBe(2);
    expect(r.skipped).toBe(0);

    const profiles: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    expect(profiles.some((p) => p.name === "twitter.com · alice")).toBe(true);
    expect(profiles.some((p) => p.name === "amazon.com · bob")).toBe(true);

    const accounts: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    expect(accounts).toHaveLength(2);
    const alice = accounts.find((a) => a.platformUserName === "alice");
    expect(alice.profileIds).toHaveLength(1);
    expect(JSON.stringify(alice)).not.toContain("s3cret");
    // The created profile resolves the account back via forProfile.
    const bound = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.agent.accounts.forProfile(id), alice.profileIds[0]);
    expect(bound.some((a: any) => a.platformUserName === "alice")).toBe(true);
  }, 30000);

  it("shows the bulk-import dialog with the create-profiles option", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("accounts"));
    await h.page.waitForTimeout(400);
    await h.page.evaluate(() => (window as any).agentBrowser.agentImportAccounts());
    await h.page.waitForSelector("#dlg-account-import[open]", { timeout: 5000 });
    const cbVisible = await h.page.evaluate(() => !!document.getElementById("acct-import-create-profiles"));
    expect(cbVisible).toBe(true);
    // Toggling the checkbox reveals the platform options.
    await h.page.locator("#acct-import-create-profiles").check({ timeout: 5000 });
    const optsVisible = await h.page.evaluate(() => document.getElementById("acct-import-create-options").style.display !== "none");
    expect(optsVisible).toBe(true);
    await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.bulkCreate(
      "https://shop.com, carol, pass1",
      { platform: "windows" },
    ));
  }, 20000);

  it("denies a viewer bulk-create", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const deviceId = cfg.deviceId || "local";
    cfg.team = {
      name: "J77 Workspace",
      ownerDeviceId: deviceId,
      members: [{ deviceId, name: "Local", role: "viewer", addedAt: Date.now() }],
      enabled: true,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    const err: string = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.agent.accounts.bulkCreate("https://x.com, u, p", { platform: "windows" })
        .then(() => "no-error")
        .catch((e: any) => e.message || String(e)));
    expect(err).toContain("requires member role");
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
