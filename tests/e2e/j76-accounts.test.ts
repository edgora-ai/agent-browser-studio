// J76: Account module alignment (Slice 53 — RoxyBrowser 3.8.9 parity).
// Covers quick copy (username/password), account<->profile binding, bulk
// import, redaction guarantees, and viewer RBAC on account secrets/mutations.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j76");

describe("J76 — accounts module alignment", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const p = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({
      name: "J76 Profile", platform: "windows", locale: "en-US",
      timezone: "America/New_York", fingerprintSeed: 424242, proxyMode: "none",
    }));
    dirId = p.dirId;
    await h.page.evaluate(async () => (window as any).agentBrowser.api.agent.accounts.add({
      platformUrl: "https://example.com", platformUserName: "j76user",
      platformPassword: "j76secret", tags: ["test"],
    }));
  }, 90000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("lists accounts redacted — the plaintext password never reaches the renderer", async () => {
    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    expect(list.length).toBe(1);
    expect(list[0].platformUserName).toBe("j76user");
    expect(list[0].hasPassword).toBe(true);
    expect(JSON.stringify(list)).not.toContain("j76secret");
  });

  it("copies the username to the system clipboard", async () => {
    const r: any = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.copyUsername(0));
    expect(r.ok).toBe(true);
    const clip = await h.app.evaluate(({ clipboard }: any) => clipboard.readText());
    expect(clip).toBe("j76user");
  });

  it("copies the password via a main-process decrypt (clipboard only)", async () => {
    const r: any = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.copyPassword(0));
    expect(r.ok).toBe(true);
    const clip = await h.app.evaluate(({ clipboard }: any) => clipboard.readText());
    expect(clip).toBe("j76secret");
  });

  it("binds the account to a profile and resolves it via forProfile", async () => {
    const updated: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.agent.accounts.bind(0, [id]), dirId);
    expect(updated.profileIds).toEqual([dirId]);
    const forProfile: any[] = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.agent.accounts.forProfile(id), dirId);
    expect(forProfile.length).toBe(1);
    expect(forProfile[0].platformUserName).toBe("j76user");
    expect(JSON.stringify(forProfile)).not.toContain("j76secret");
  });

  it("bulk imports accounts from pasted text and skips malformed lines", async () => {
    const r: any = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.bulkAdd(
      "https://a.com, a_user, a_pass, social\nhttps://b.com, b_user, b_pass, shop|prime\n, bad_line, x"
    ));
    // The parser drops malformed lines before the store, so skipped stays 0
    // and the bad line never becomes an account.
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    expect(list.length).toBe(3);
  });


  it("renders the accounts tab with quick-copy and bind buttons", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("accounts"));
    await h.page.waitForTimeout(500);
    await h.page.waitForSelector("#accounts-tab-list .card", { timeout: 5000 });
    const copyBtns = await h.page.evaluate(() => document.querySelectorAll("#accounts-tab-list button[title='Copy password']").length);
    expect(copyBtns).toBeGreaterThan(0);
    const bindBtns = await h.page.evaluate(() => document.querySelectorAll("#accounts-tab-list button[title='Bind to profiles']").length);
    expect(bindBtns).toBeGreaterThan(0);
    const exportBtn = await h.page.evaluate(() => { const el = document.getElementById("acct-export-btn"); return el ? el.style.display !== "none" : false; });
    expect(exportBtn).toBe(true);
  }, 20000);

  it("denies a viewer account secrets and mutations", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const deviceId = cfg.deviceId || "local";
    cfg.team = {
      name: "J76 Workspace",
      ownerDeviceId: deviceId,
      members: [{ deviceId, name: "Local", role: "viewer", addedAt: Date.now() }],
      enabled: true,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const copyErr: string = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.agent.accounts.copyPassword(0)
        .then(() => "no-error")
        .catch((e: any) => e.message || String(e)));
    expect(copyErr).toContain("requires member role");

    const bulkErr: string = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.agent.accounts.bulkAdd("https://x.com, u, p")
        .then(() => "no-error")
        .catch((e: any) => e.message || String(e)));
    expect(bulkErr).toContain("requires member role");

    const addErr: string = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.agent.accounts.add({ platformUrl: "https://x.com", platformUserName: "u", platformPassword: "p" })
        .then(() => "no-error")
        .catch((e: any) => e.message || String(e)));
    expect(addErr).toContain("requires member role");
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
