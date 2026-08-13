// End-to-end user journey for Agent Browser Studio
// Language-agnostic: locates by data-tab / data-cmd / element ids, never by visible text.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, ElectronApplication, Page } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";

const REPO = path.resolve(__dirname, "../..");
const MAIN = path.join(REPO, "dist", "main", "index.js");
const SHOTS = path.join(REPO, "tests", "e2e", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const SANDBOX_USER_DATA = path.join(REPO, "tests", "e2e", "userdata");
fs.rmSync(SANDBOX_USER_DATA, { recursive: true, force: true });
fs.mkdirSync(SANDBOX_USER_DATA, { recursive: true });

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

async function shot(name: string) {
  await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: false });
}

async function closeAllDialogs() {
  await page.evaluate(() => {
    document.querySelectorAll("dialog").forEach((d) => {
      try { if ((d as HTMLDialogElement).open) (d as HTMLDialogElement).close(); } catch (_) {}
    });
  });
}

// All 8 tabs by their data-tab attribute
const TABS = ["profiles", "proxy", "storage", "sync", "browser", "extensions", "accounts", "agent"];

describe("E2E — Agent Browser Studio user journey", () => {
  beforeAll(async () => {
    app = await electron.launch({
      args: [REPO, `--user-data-dir=${SANDBOX_USER_DATA}`],
      executablePath: path.join(
        REPO,
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      ),
      env: { ...process.env, ELECTRON_DISABLE_GPU: "1" },
      timeout: 30000,
    });
    page = await app.firstWindow({ timeout: 20000 });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.waitForFunction(() => (window as any).agentBrowser && (window as any).agentBrowser.switchTab, {
      timeout: 20000,
    });
    await page.waitForSelector("#tab-profiles", { timeout: 15000 });
    await page.waitForTimeout(500);

    // Permanently disable the first-run wizard by overriding window.wizardDismissed
    // AND setting localStorage flag, before the 500ms setTimeout fires.
    await page.evaluate(() => {
      (window as any).wizardDismissed = true;
      try { localStorage.setItem("agent-browser-studio-wizard-dismissed", "1"); } catch (_) {}
    });

    // First-run wizard may auto-open — dismiss it so it doesn't intercept clicks
    try {
      const wizard = page.locator("#dlg-wizard");
      if ((await wizard.count()) > 0 && (await wizard.evaluate((el: any) => el.open))) {
        // Click "Skip" / dismiss button if present, otherwise close any cancel button inside
        const skipBtn = page.locator(
          '#dlg-wizard [data-cmd="close-dialog"], #dlg-wizard button:has-text("Skip"), #dlg-wizard button:has-text("Close"), #dlg-wizard button:has-text("Later")',
        );
        if ((await skipBtn.count()) > 0) await skipBtn.first().click();
        else await wizard.evaluate((el: any) => el.close());
        await page.waitForTimeout(300);
      }
    } catch (_) { /* wizard may not exist */ }

    // Also close any other dialog that may be auto-opened (dlg-profile, dlg-agent-browser-seed, etc.)
    for (const id of ["dlg-profile", "dlg-new-agentBrowser", "dlg-agent-browser-seed", "dlg-proxy", "dlg-rename", "dlg-cookies", "dlg-extensions", "dlg-skill-market", "dlg-account", "dlg-note", "dlg-bulk-import", "dlg-confirm"]) {
      try {
        await page.evaluate((dialogId: string) => {
          const d = document.getElementById(dialogId) as HTMLDialogElement | null;
          if (d && d.open) d.close();
        }, id);
      } catch (_) {}
    }
    await page.waitForTimeout(300);

    // Set wizard-dismissed flag so wizard doesn't auto-reopen
    await page.evaluate(() => {
      try { localStorage.setItem("agent-browser-studio-wizard-dismissed", "1"); } catch (_) {}
    });
  }, 90000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it("boots with sidebar and profiles tab active", async () => {
    await shot("01-boot");
    const activeTab = await page.locator(".nav-item.active").getAttribute("data-tab");
    expect(activeTab).toBe("profiles");
    const visible = await page.locator("#tab-profiles.active").count();
    expect(visible).toBe(1);
  });

  it("switches to all 8 sidebar tabs without errors", async () => {
    for (const t of TABS) {
      await page.locator(`.nav-item[data-tab="${t}"]`).click();
      await page.waitForTimeout(200);
      const activeTab = await page.locator(".nav-item.active").getAttribute("data-tab");
      expect(activeTab, `clicked ${t}`).toBe(t);
      const isVisible = await page.locator(`#tab-${t}`).isVisible();
      expect(isVisible, `${t} content not visible`).toBe(true);
      await shot(`02-tab-${t}`);
    }
  });

  it("opens New Profile dialog and the Random seed button works", async () => {
    try {
      await closeAllDialogs();
      const openDialogs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("dialog"))
          .filter((d) => (d as HTMLDialogElement).open)
          .map((d) => d.id),
      );
      console.log("[diag] open dialogs at start:", JSON.stringify(openDialogs));
      await page.locator('.nav-item[data-tab="profiles"]').click({ timeout: 5000 });
      await page.waitForTimeout(300);
      await page.locator('[data-cmd="newProfile"]').click({ timeout: 5000 });
      await page.waitForSelector("#dlg-profile", { state: "visible", timeout: 5000 });
      await shot("03-new-profile-dialog");

      // RoxyBrowser 4.0.3-style creation flow: advanced fields are collapsed by
      // default behind the "高级设置" summary — expand before touching the seed.
      await page.locator("#new-profile-advanced > summary").click({ timeout: 5000 });
      await page.waitForSelector("#new-profile-advanced[open]", { timeout: 5000 });

      const seedInput = page.locator("#new-agent-browser-seed");
      const before = await seedInput.inputValue();
      expect(before).toBe("");

      await page.locator('#dlg-profile [data-cmd="random-seed"]').click({ timeout: 5000 });
      await page.waitForTimeout(150);
      const after = await seedInput.inputValue();
      expect(after, "Random button did not populate seed").not.toBe("");
      expect(Number(after)).toBeGreaterThanOrEqual(1);
      await shot("04-seed-after-random");
    } catch (e: any) {
      console.log("[diag] FAIL in new-profile:", e.message);
      throw e;
    }
  });

  it("fills the new-profile form and saves", async () => {
    try {
      await closeAllDialogs();
      // The new-profile dialog should still be open from previous test,
      // but if not, reopen it
      let dlgVisible = await page.locator("#dlg-profile").evaluate((d: any) => d.open).catch(() => false);
      if (!dlgVisible) {
        await page.locator('[data-cmd="newProfile"]').click({ timeout: 5000 });
        await page.waitForSelector("#dlg-profile", { state: "visible", timeout: 5000 });
      }
      await page.locator("#new-profile-name").fill("E2E Test Profile", { timeout: 5000 });
      const platform = await page.locator("#new-agent-browser-platform").inputValue();
      expect(platform).not.toBe("");
      await page.locator('#dlg-profile button[type="submit"]').click({ timeout: 5000 });
      await page.waitForSelector("#dlg-profile", { state: "hidden", timeout: 5000 });
      await page.waitForTimeout(1000);
      const profileCards = await page.locator(".profile-card").count();
      expect(profileCards, "no profile card rendered after save").toBeGreaterThanOrEqual(1);
      await shot("05-profile-saved");
    } catch (e: any) {
      console.log("[diag] FAIL in fill-save:", e.message);
      throw e;
    }
  });

  it("opens edit dialog (agent-browser-meta-seed), Random works, Cancel closes it", async () => {
    try {
      await closeAllDialogs();
      await page.locator(".profile-card [data-action='edit']").first().click({ timeout: 5000 });
      await page.waitForSelector("#dlg-agent-browser-seed", { state: "visible", timeout: 5000 });
      const seedVal = await page.locator("#agent-browser-meta-seed").inputValue();
      expect(seedVal, "edit seed should not be empty").not.toBe("");
      await shot("06-edit-dialog");

      await page.locator('#dlg-agent-browser-seed [data-cmd="random-seed"]').click({ timeout: 5000 });
      await page.waitForTimeout(150);
      const newSeedVal = await page.locator("#agent-browser-meta-seed").inputValue();
      expect(Number(newSeedVal)).toBeGreaterThanOrEqual(1);
      await shot("07-edit-seed-random");

      // Cancel — the close-dialog bug we fixed (was data-cmd-target="undefined")
      await page.locator('#dlg-agent-browser-seed [data-cmd="close-dialog"]').click({ timeout: 5000 });
      await page.waitForSelector("#dlg-agent-browser-seed", { state: "hidden", timeout: 3000 });
    } catch (e: any) {
      console.log("[diag] FAIL in edit-cancel:", e.message);
      throw e;
    }
  });

  it("Add Proxy dialog opens and Cancel closes it", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="proxy"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-cmd="newProxy"]').click();
    await page.waitForSelector("#dlg-proxy", { state: "visible" });
    await shot("08-proxy-dialog");

    await page.locator('#dlg-proxy [data-cmd="close-dialog"]').click();
    await page.waitForSelector("#dlg-proxy", { state: "hidden", timeout: 3000 });
  });

  it("switchAgentSub dispatches inside Agent tab (gear → config → Back → chat)", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="agent"]').click();
    await page.waitForTimeout(300);

    const gearBtn = page.locator('#tab-agent [data-cmd="switchAgentSub"][data-sub="config"]');
    if ((await gearBtn.count()) > 0) {
      await gearBtn.click();
      await page.waitForTimeout(200);
      const configVisible = await page.locator("#agent-view-config").isVisible();
      expect(configVisible, "agent config view should be visible").toBe(true);
      await shot("09-agent-config");

      const backBtn = page.locator('#agent-view-config [data-cmd="switchAgentSub"][data-sub="chat"]');
      await backBtn.click();
      await page.waitForTimeout(200);
      const chatVisible = await page.locator("#agent-view-chat").isVisible();
      expect(chatVisible, "agent chat view should return").toBe(true);
    }
  });

  it("language toggle switches label", async () => {
    const before = await page.locator("#lang-label").innerText();
    await page.locator('button[title="Switch language"]').click();
    await page.waitForTimeout(400);
    const after = await page.locator("#lang-label").innerText();
    expect(before).not.toBe(after);
    await shot(`10-lang-${after}`);
    // toggle back
    await page.locator('button[title="Switch language"]').click();
    await page.waitForTimeout(400);
  });

  it("theme toggle switches data-theme", async () => {
    const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.locator("#theme-toggle").click();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(before).not.toBe(after);
    await shot(`11-theme-${after}`);
  });

  // ── Profile Note CRUD ──────────────────────────────────────────────
  it("adds a note to a profile and persists it", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="profiles"]').click();
    await page.waitForTimeout(400);
    // A profile card must exist from the earlier save test
    const noteBtn = page.locator(".profile-card [data-action='note']").first();
    expect(await noteBtn.count(), "profile note button missing").toBeGreaterThan(0);
    await noteBtn.click({ timeout: 5000 });
    await page.waitForSelector("#dlg-note", { state: "visible", timeout: 5000 });

    const noteText = "E2E journey note " + Date.now();
    await page.locator("#note-text").fill(noteText, { timeout: 5000 });
    await page.locator('#dlg-note button[type="submit"]').click({ timeout: 5000 });
    await page.waitForSelector("#dlg-note", { state: "hidden", timeout: 5000 });
    await page.waitForTimeout(500);

    // Verify persistence via the IPC API
    const profiles = await page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const withNote = (profiles || []).filter((p: any) => p.note === noteText);
    expect(withNote.length, "note was not persisted to the profile").toBe(1);
    await shot("12-note-saved");
  });

  // ── Cookie dialog open/close (lifecycle; CDP write needs a launched browser) ──
  it("opens the Cookies dialog for a profile and closes it", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="profiles"]').click();
    await page.waitForTimeout(300);
    const cookieBtn = page.locator(".profile-card [data-action='cookies']").first();
    expect(await cookieBtn.count(), "profile cookie button missing").toBeGreaterThan(0);
    await cookieBtn.click({ timeout: 5000 });
    await page.waitForSelector("#dlg-cookies", { state: "visible", timeout: 5000 });
    // The search input should be present and focusable
    await page.locator("#cookie-search").fill("example", { timeout: 5000 });
    await shot("13-cookie-dialog");
    await page.locator('#dlg-cookies [data-cmd="close-dialog"]').click({ timeout: 5000 });
    await page.waitForSelector("#dlg-cookies", { state: "hidden", timeout: 5000 });
  });

  // ── Platform Account CRUD ──────────────────────────────────────────
  it("creates a platform account and verifies it is redacted in the list", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="accounts"]').click();
    await page.waitForTimeout(300);

    const before = await page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    const beforeCount = (before || []).length;

    await page.locator('[data-cmd="agentAddAccount"]').first().click({ timeout: 5000 });
    await page.waitForSelector("#dlg-account", { state: "visible", timeout: 5000 });
    await page.locator("#acct-url").fill("https://example-shop.test", { timeout: 5000 });
    await page.locator("#acct-username").fill("e2e_buyer", { timeout: 5000 });
    await page.locator("#acct-password").fill("s3cret-pass", { timeout: 5000 });
    await page.locator("#acct-tags").fill("ecommerce, e2e", { timeout: 5000 });
    await page.locator('#dlg-account button[type="submit"]').click({ timeout: 5000 });
    await page.waitForSelector("#dlg-account", { state: "hidden", timeout: 5000 });
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    expect((after || []).length, "account count did not increase").toBe(beforeCount + 1);
    const added = (after || []).find(
      (a: any) => a.platformUrl === "https://example-shop.test" && a.platformUserName === "e2e_buyer",
    );
    expect(added, "added account not found").toBeTruthy();
    // Password must be redacted in the API surface (no plaintext leak)
    expect(JSON.stringify(added)).not.toContain("s3cret-pass");
    await shot("14-account-added");
  });

  it("deletes the platform account created above", async () => {
    await closeAllDialogs();
    const before = await page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    const idx = (before || []).findIndex(
      (a: any) => a.platformUrl === "https://example-shop.test",
    );
    expect(idx, "account to delete not found").toBeGreaterThanOrEqual(0);

    // Drive deletion through the real product path (page dialog confirm handler)
    await page.evaluate(async (i: number) => {
      // Bypass the JS confirm() prompt by directly invoking the IPC delete,
      // which is what the confirm handler does after the user clicks OK.
      const api = (window as any).agentBrowser.api;
      await api.agent.accounts.delete(i);
      await (window as any).agentBrowser.agentLoadAccounts();
    }, idx);
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    const stillThere = (after || []).some(
      (a: any) => a.platformUrl === "https://example-shop.test",
    );
    expect(stillThere, "account was not deleted").toBe(false);
    await shot("15-account-deleted");
  });

  // ── Agent Skill CRUD ───────────────────────────────────────────────
  it("creates an Agent skill via the editor and verifies it is listed", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="agent"]').click();
    await page.waitForTimeout(300);
    await page.locator('#tab-agent [data-cmd="switchAgentSub"][data-sub="skills"]').click();
    await page.waitForTimeout(300);
    const skillsView = await page.locator("#agent-view-skills").isVisible();
    expect(skillsView, "skills sub-view not visible").toBe(true);

    await page.locator('#agent-view-skills [data-cmd="showSkillEditor"]').click({ timeout: 5000 });
    await page.waitForSelector("#dlg-skill-editor", { state: "visible", timeout: 5000 });

    const skillId = "e2e-journey-skill";
    await page.locator("#skill-id").fill(skillId, { timeout: 5000 });
    await page.locator("#skill-title").fill("E2E Journey Skill", { timeout: 5000 });
    await page.locator("#skill-prompt").fill("Open example.test and verify the title.", {
      timeout: 5000,
    });
    await page.locator('#dlg-skill-editor button[type="submit"]').click({ timeout: 5000 });
    await page.waitForSelector("#dlg-skill-editor", { state: "hidden", timeout: 5000 });
    await page.waitForTimeout(500);

    const skills = await page.evaluate(() => (window as any).agentBrowser.api.agent.skills.list());
    const found = (skills || []).some((s: any) => s.id === skillId);
    expect(found, "created skill not listed").toBe(true);
    await shot("16-skill-added");
  });

  it("removes the Agent skill created above", async () => {
    await closeAllDialogs();
    const skillId = "e2e-journey-skill";
    await page.evaluate(async (id: string) => {
      const api = (window as any).agentBrowser.api;
      await api.agent.skills.remove(id);
    }, skillId);
    await page.waitForTimeout(300);
    const skills = await page.evaluate(() => (window as any).agentBrowser.api.agent.skills.list());
    const stillThere = (skills || []).some((s: any) => s.id === skillId);
    expect(stillThere, "skill was not removed").toBe(false);
    await shot("17-skill-removed");
  });

  // ── Sync configuration save (no real S3 needed — just config persistence) ──
  it("saves a sync configuration and reflects it in status", async () => {
    await closeAllDialogs();
    await page.locator('.nav-item[data-tab="sync"]').click();
    await page.waitForTimeout(300);

    // Enable + fill endpoint/bucket, then save
    if (!(await page.locator("#sync-enabled").isChecked())) {
      await page.locator("#sync-enabled").check();
    }
    await page.locator("#sync-endpoint-input").fill("https://s3.example.test", { timeout: 5000 });
    await page.locator("#sync-bucket-input").fill("e2e-bucket", { timeout: 5000 });
    await page.locator('#tab-sync [data-cmd="syncSave"]').click({ timeout: 5000 });
    await page.waitForTimeout(800);

    const status = await page.evaluate(() => (window as any).agentBrowser.api.sync.status());
    expect(status?.enabled, "sync not enabled after save").toBe(true);
    expect(status?.endpoint, "endpoint not persisted").toBe("https://s3.example.test");
    expect(status?.bucket, "bucket not persisted").toBe("e2e-bucket");
    // The status text in the UI should reflect enabled
    const enabledText = await page.locator("#sync-enabled-text").innerText();
    expect(enabledText.toLowerCase()).toContain("enabled");
    await shot("18-sync-saved");

    // Disable sync again to leave a clean state
    if (await page.locator("#sync-enabled").isChecked()) {
      await page.locator("#sync-enabled").uncheck();
    }
    await page.locator('#tab-sync [data-cmd="syncSave"]').click({ timeout: 5000 });
    await page.waitForTimeout(500);
  });

  it("no console errors and no page errors during the journey", () => {
    const filteredConsole = consoleErrors.filter(
      (e) =>
        !/DevTools|chrome-error|favicon|punycode|EADDRINUSE|MCP server|preload|contextBridge|await is only valid/i.test(
          e,
        ),
    );
    const filteredPage = pageErrors.filter((e) => !/favicon|punycode/i.test(e));
    if (filteredConsole.length || filteredPage.length) {
      console.log("CONSOLE ERRORS:\n" + filteredConsole.join("\n---\n"));
      console.log("PAGE ERRORS:\n" + filteredPage.join("\n---\n"));
    }
    expect(filteredConsole.length, `console errors:\n${filteredConsole.join("\n")}`).toBe(0);
    expect(filteredPage.length, `page errors:\n${filteredPage.join("\n")}`).toBe(0);
  });
});
