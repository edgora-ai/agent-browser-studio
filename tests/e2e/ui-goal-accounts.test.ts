// Prepared serial native acceptance — NOT RUN by the renderer worker.
// Requires a coordinator-approved fresh physical snapshot and built-source hash
// equality BEFORE launching. No source reinjection, real clipboard or browsers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { closeApp, setupTestApp, userDataConfigPath, type TestAppHandle } from "./helpers/app.js";
import type { AccountReference } from "../../src/renderer/api.js";

const REPO = path.resolve(__dirname, "../..");
const SOURCE = path.join(REPO, "src/renderer/js/app/accounts.js");
const BUILT = path.join(REPO, "dist/renderer/js/app/accounts.js");
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const PROFILE_A = "1700000000000_accounts_a", PROFILE_B = "1700000000000_accounts_b";
const PROFILES = [{ dirId: PROFILE_A, name: "Duplicate synthetic account profile" }, { dirId: PROFILE_B, name: "Duplicate synthetic account profile" }];

describe("UI goal accounts — coordinator-only fresh-build serial native acceptance", () => {
  let h: TestAppHandle;
  let root: string;
  let userData: string;
  beforeAll(async () => {
    const approved = process.env.ABS_ACCOUNT_NATIVE_SNAPSHOT_ROOT;
    if (!approved || fs.realpathSync(approved) !== fs.realpathSync(REPO)) throw new Error("NOT-RUN: coordinator must approve this fresh physical snapshot root");
    if (!process.env.ABS_ACCOUNT_NATIVE_SOURCE_SHA256 || digest(SOURCE) !== process.env.ABS_ACCOUNT_NATIVE_SOURCE_SHA256) throw new Error("NOT-RUN: frozen account source hash required");
    if (digest(BUILT) !== digest(SOURCE)) throw new Error("NOT-RUN: account built-source equality prerequisite failed");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-accounts-native-"));
    userData = path.join(root, "userdata");
    const cache = path.join(root, "empty-browser-fixture-cache"); fs.mkdirSync(cache);
    h = await setupTestApp({ userDataDir: userData, allowProfileVersionSelection: true, env: { AGENT_BROWSER_CHROMIUM_CACHE_DIR: cache, AGENT_BROWSER_SECRET_BACKEND: "file" } });
    expect(fs.realpathSync(fileURLToPath(h.page.url()))).toBe(fs.realpathSync(path.join(REPO, "dist/renderer/index.html")));
    // Fixture the external provider in main, retaining the real built renderer,
    // preload, IPC handlers and actual config/vault. No module re-evaluation.
    await h.app.evaluate(({ ipcMain }, profiles) => {
      const map = (ipcMain as any)._invokeHandlers as Map<string, any>;
      if (!(map instanceof Map)) throw new Error("Native fixture requires explicit IPC handler inventory");
      const trace: any = { writes: [], mode: "ready", reads: 0, resolve: null, profiles };
      (globalThis as any).__accountsNativeFixture = trace;
      ipcMain.removeHandler("browser:list");
      ipcMain.handle("browser:list", () => {
        trace.reads++;
        if (trace.mode === "fail") throw new Error("controlled synthetic profile read failure");
        if (trace.mode === "delay") return new Promise(resolve => { trace.resolve = resolve; });
        return trace.profiles;
      });
      for (const name of ["get", "bind", "update", "delete"]) {
        const channel = "agent:accounts:" + name, original = map.get(channel);
        if (!original) throw new Error("Missing account IPC handler " + channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, ...args) => { trace.writes.push({ name, args }); return original(event, ...args); });
      }
      // Absolute blocker, even if a later test accidentally clicks a copy control.
      for (const name of ["copy-username", "copy-password"]) {
        const channel = "agent:accounts:" + name; ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => { throw new Error("Real clipboard prohibited in native account acceptance"); });
      }
    }, PROFILES);
  }, 90_000);
  afterAll(async () => {
    try { if (h) await closeApp(h); }
    finally {
      if (root) {
        if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ui-goal-accounts-native-")) throw new Error("Unsafe native fixture cleanup");
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 90_000);
  function config() { return JSON.parse(fs.readFileSync(userDataConfigPath(userData), "utf8")); }
  async function reload() {
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    await h.page.reload(); await h.page.waitForFunction(() => Boolean((window as any).agentBrowser?.agentBindAccounts));
  }
  async function pendingProfileRead() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await h.app.evaluate(() => Boolean((globalThis as any).__accountsNativeFixture.resolve))) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Synthetic profile read did not become pending within 5s");
  }
  async function fixture(mode: "ready" | "fail" | "delay") {
    await h.app.evaluate((_electron, mode) => { const f = (globalThis as any).__accountsNativeFixture; f.mode = mode; if (mode === "delay") f.resolve = null; }, mode);
  }
  async function trace(name: string) { return h.app.evaluate((_electron, name) => (globalThis as any).__accountsNativeFixture.writes.filter((w: any) => w.name === name), name); }
  async function refs(): Promise<AccountReference[]> { return h.page.evaluate(async () => (await (window as any).agentBrowser.api.agent.accounts.list()).map((a: any) => a.ref)); }
  async function bind(index: number) { const ref = (await refs())[index]; await h.page.evaluate(ref => (window as any).agentBrowser.agentBindAccounts(ref), ref); }
  async function edit(index: number) { const ref = (await refs())[index]; await h.page.evaluate(ref => (window as any).agentBrowser.agentEditAccount(ref), ref); }
  async function remove(index: number) { const ref = (await refs())[index]; await h.page.evaluate(ref => (window as any).agentBrowser.api.agent.accounts.delete(ref.index, ref), ref); }
  async function noSuccess() { expect(await h.page.locator(".toast-success").count()).toBe(0); }
  beforeEach(async () => {
    const cfg = config(); delete cfg.team; cfg.accounts = []; fs.writeFileSync(userDataConfigPath(userData), JSON.stringify(cfg, null, 2));
    await fixture("ready"); await reload();
    await h.page.evaluate(async ({ a, b }) => {
      const accounts = (window as any).agentBrowser.api.agent.accounts;
      await accounts.add({ platformUrl: "https://accounts-fixture.invalid", platformUserName: "native-fixture-alice", platformPassword: "synthetic-native-secret", profileIds: [a], tags: ["synthetic"] });
      await accounts.add({ platformUrl: "https://accounts-fixture.invalid", platformUserName: "native-fixture-bob", platformPassword: "synthetic-native-secret-bob", profileIds: [b], tags: ["synthetic"] });
      document.getElementById("toast-stack")?.replaceChildren();
    }, { a: PROFILE_A, b: PROFILE_B });
    await h.app.evaluate(() => { (globalThis as any).__accountsNativeFixture.writes = []; });
  });
  async function assertStoredBindings(ids: string[] | undefined, index = 0) {
    expect(config().accounts[index].profileIds).toEqual(ids);
    expect(fs.readFileSync(userDataConfigPath(userData), "utf8")).not.toContain("synthetic-native-secret");
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
    const list = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list());
    expect(list[index].profileIds).toEqual(ids); expect(JSON.stringify(list)).not.toContain("synthetic-native-secret");
    const matches = await h.page.evaluate(id => (window as any).agentBrowser.api.agent.accounts.forProfile(id), ids?.[0] || PROFILE_B);
    expect(matches.some((a: any) => a.platformUserName === list[index].platformUserName)).toBe(true);
  }
  it("failed read and direct Save preserve actual bytes; same-ref Retry loads bindings and intentional empty Save persists", async () => {
    const before = fs.readFileSync(userDataConfigPath(userData)); const original = (await refs())[0];
    await fixture("fail"); await bind(0);
    const save = h.page.locator('#dlg-account-bind [data-cmd="agentSaveAccountBind"]');
    expect(await save.isDisabled()).toBe(true); expect(await h.page.locator("#dlg-account-bind").evaluate((el: HTMLDialogElement) => el.open)).toBe(true);
    await h.page.evaluate(() => (window as any).agentBrowser.agentSaveAccountBind());
    expect(await trace("bind")).toEqual([]); expect(fs.readFileSync(userDataConfigPath(userData))).toEqual(before); await noSuccess();
    expect(config().accounts[0].profileIds).toEqual([PROFILE_A]);
    await fixture("ready"); const retry = h.page.locator('#acct-bind-list [data-cmd="agentBindAccounts"]');
    expect(JSON.parse((await retry.getAttribute("data-cmd-arg"))!)).toEqual(original); await retry.click();
    await h.page.waitForFunction(() => !(document.querySelector('#dlg-account-bind [data-cmd="agentSaveAccountBind"]') as HTMLButtonElement).disabled);
    expect(await h.page.locator(`#acct-bind-list input[value="${PROFILE_A}"]`).isChecked()).toBe(true);
    for (const p of PROFILES) expect(await h.page.locator(`#acct-bind-list label:has(input[value="${p.dirId}"])`).textContent()).toContain(p.dirId);
    await h.page.locator(`#acct-bind-list input[value="${PROFILE_A}"]`).uncheck(); await save.click();
    await h.page.waitForFunction(() => !(document.getElementById("dlg-account-bind") as HTMLDialogElement).open);
    expect((await trace("bind")).map((w: any) => w.args)).toEqual([[{ index: 0, profileIds: [], ref: original }]]); await assertStoredBindings(undefined);
  });
  it("delayed read keeps Save disabled; delegated Cancel prevents late reopening or direct write", async () => {
    const before = fs.readFileSync(userDataConfigPath(userData)); const ref = (await refs())[0];
    await fixture("delay"); await h.page.evaluate(ref => { void (window as any).agentBrowser.agentBindAccounts(ref); }, ref);
    await h.page.waitForFunction(() => (document.getElementById("dlg-account-bind") as HTMLDialogElement).open);
    expect(await h.page.locator('#dlg-account-bind [data-cmd="agentSaveAccountBind"]').isDisabled()).toBe(true);
    await pendingProfileRead();
    await h.page.evaluate(() => (window as any).agentBrowser.agentSaveAccountBind()); await h.page.locator('#dlg-account-bind [data-cmd="close-dialog"]').first().click();
    await h.app.evaluate(() => { const f = (globalThis as any).__accountsNativeFixture; if (!f.resolve) throw new Error("Delayed read not pending"); f.resolve(f.profiles); });
    await h.page.evaluate(() => (window as any).agentBrowser.agentSaveAccountBind());
    expect(await h.page.locator("#dlg-account-bind").evaluate((el: HTMLDialogElement) => el.open)).toBe(false); expect(await trace("bind")).toEqual([]);
    expect(fs.readFileSync(userDataConfigPath(userData))).toEqual(before); await assertStoredBindings([PROFILE_A]);
  });
  it("late checklist response cannot replace another account's checked bindings", async () => {
    await fixture("delay"); const first = (await refs())[0]; await h.page.evaluate(ref => { void (window as any).agentBrowser.agentBindAccounts(ref); }, first);
    await h.page.waitForFunction(() => (document.getElementById("dlg-account-bind") as HTMLDialogElement).open);
    // Read readiness must be observed in main before delivering the old result.
    await pendingProfileRead();
    await fixture("ready"); await bind(1); await h.app.evaluate(() => { const f = (globalThis as any).__accountsNativeFixture; f.resolve(f.profiles); });
    expect(await h.page.locator("#acct-bind-index").inputValue()).toBe("1");
    expect(await h.page.locator(`#acct-bind-list input[value="${PROFILE_B}"]`).isChecked()).toBe(true); expect(await h.page.locator(`#acct-bind-list input[value="${PROFILE_A}"]`).isChecked()).toBe(false);
    await h.page.locator('#dlg-account-bind [data-cmd="agentSaveAccountBind"]').click(); await h.page.waitForFunction(() => !(document.getElementById("dlg-account-bind") as HTMLDialogElement).open);
    await assertStoredBindings([PROFILE_A], 0); await assertStoredBindings([PROFILE_B], 1);
  });
  it("real conflict update and bind retain dialogs without false success", async () => {
    await edit(1); await remove(1); const before = fs.readFileSync(userDataConfigPath(userData));
    await h.page.evaluate(() => (window as any).agentBrowser.saveAccount());
    expect(await h.page.locator("#dlg-account").evaluate((el: HTMLDialogElement) => el.open)).toBe(true); await noSuccess();
    expect(fs.readFileSync(userDataConfigPath(userData))).toEqual(before); await h.page.locator('#dlg-account [data-cmd="close-dialog"]').first().click();
    await bind(0); await remove(0); await h.page.evaluate(() => (window as any).agentBrowser.agentSaveAccountBind());
    expect(await h.page.locator("#dlg-account-bind").evaluate((el: HTMLDialogElement) => el.open)).toBe(true); expect(await h.page.locator('#dlg-account-bind [data-cmd="agentSaveAccountBind"]').isDisabled()).toBe(true); await noSuccess();
    expect(config().accounts).toEqual([]); await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig()); expect(await refs()).toEqual([]);
  });
  for (const surface of ["accounts-tab-list", "agent-accounts-list"]) {
    it(surface + " preserves original edit/confirmation references across cross-client reorder", async () => {
      await h.page.evaluate(surface => { const ab = (window as any).agentBrowser; ab.switchTab(surface === "accounts-tab-list" ? "accounts" : "agent"); if (surface === "agent-accounts-list") ab.switchAgentSub("accounts"); ab.loadAccountsTab(); ab.agentLoadAccounts(); }, surface);
      const editButton = h.page.locator(`#${surface} [data-cmd="agentEditAccount"]`).first(); await editButton.waitFor(); await editButton.click();
      await h.page.locator("#acct-username").fill("native-unsaved"); await h.page.locator("#acct-tags").fill("native-retained");
      const cfg = config(); cfg.accounts.reverse(); fs.writeFileSync(userDataConfigPath(userData), JSON.stringify(cfg, null, 2)); await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
      const before = fs.readFileSync(userDataConfigPath(userData)); await h.page.evaluate(() => (window as any).agentBrowser.saveAccount());
      expect(await h.page.locator("#acct-username").inputValue()).toBe("native-unsaved"); expect(await h.page.locator("#acct-tags").inputValue()).toBe("native-retained");
      expect(await h.page.locator('#dlg-account button[type="submit"]').isDisabled()).toBe(true); await noSuccess();
      await h.page.evaluate(() => (window as any).agentBrowser.saveAccount()); expect(fs.readFileSync(userDataConfigPath(userData))).toEqual(before);
      await h.page.locator('#dlg-account [data-cmd="close-dialog"]').first().click();
      await h.page.locator(`#${surface} [data-cmd="agentDeleteAccount"]`).first().click();
      const selected = (await refs())[0]; await remove(0); const survivor = fs.readFileSync(userDataConfigPath(userData));
      await h.page.locator('#dlg-confirm [data-cmd="doConfirm"]').click(); await h.page.waitForFunction(() => document.querySelectorAll(".toast-error").length > 0);
      expect(fs.readFileSync(userDataConfigPath(userData))).toEqual(survivor); await noSuccess();
      expect((await trace("delete")).at(-1).args).toEqual([selected.index, selected]);
    });
  }
  it("real viewer role hides manage actions on both surfaces and backend denies direct mutation", async () => {
    const cfg = config(); cfg.team = { name: "Synthetic accounts viewer workspace", enabled: true, ownerDeviceId: "synthetic-other-owner", members: [{ deviceId: cfg.deviceId, name: "Synthetic viewer", role: "viewer", addedAt: 1 }], updatedAt: 1 };
    fs.writeFileSync(userDataConfigPath(userData), JSON.stringify(cfg, null, 2)); await reload();
    await h.page.evaluate(() => { const ab = (window as any).agentBrowser; ab.loadAccountsTab(); ab.agentLoadAccounts(); });
    await h.page.waitForFunction(() => document.querySelectorAll("#accounts-tab-list .card").length === 2 && document.querySelectorAll("#agent-accounts-list .card").length === 2);
    for (const selector of ['#tab-accounts [data-cmd="agentAddAccount"]', '#tab-agent [data-cmd="agentAddAccount"]', '#acct-bulk-import-btn', '#acct-export-btn']) expect(await h.page.locator(selector).evaluate((el: HTMLElement) => el.style.display)).toBe("none");
    for (const id of ["accounts-tab-list", "agent-accounts-list"]) expect(await h.page.locator(`#${id} button`).count()).toBe(2); // Never click clipboard controls.
    const before = fs.readFileSync(userDataConfigPath(userData)); const ref = (await refs())[0];
    await h.page.evaluate(async ref => { const ab = (window as any).agentBrowser; await ab.agentAddAccount(); await ab.agentEditAccount(ref); await ab.agentDeleteAccount(ref); await ab.agentBindAccounts(ref); await ab.agentImportAccounts(); }, ref);
    for (const id of ["dlg-account", "dlg-account-bind", "dlg-account-import"]) expect(await h.page.locator(`#${id}`).evaluate((el: HTMLDialogElement) => el.open)).toBe(false);
    const denial = await h.page.evaluate(ref => (window as any).agentBrowser.api.agent.accounts.bind(ref.index, [], ref).then(() => "unexpected success", (e: Error) => e.message), ref);
    expect(denial).toContain("requires member role"); expect(fs.readFileSync(userDataConfigPath(userData))).toEqual(before); await assertStoredBindings([PROFILE_A]);
    const emptyCfg = config(); emptyCfg.accounts = []; fs.writeFileSync(userDataConfigPath(userData), JSON.stringify(emptyCfg, null, 2));
    await h.page.evaluate(async () => { const ab = (window as any).agentBrowser; await ab.api.app.reloadConfig(); ab.agentLoadAccounts(); });
    await h.page.waitForFunction(() => document.querySelectorAll("#accounts-tab-list .card, #agent-accounts-list .card").length === 0);
    expect(await h.page.locator('#accounts-tab-list [data-cmd="agentAddAccount"], #agent-accounts-list [data-cmd="agentAddAccount"]').count()).toBe(0); expect(h.pageErrors).toEqual([]);
  });
});
