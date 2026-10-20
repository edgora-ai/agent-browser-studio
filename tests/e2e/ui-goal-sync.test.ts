// SERIAL COORDINATOR ONLY: real Electron UI with fake Sync/team APIs.
// These checks do not establish S3 persistence or OS dropdown geometry.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-sync-e2e-"));
const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/js/app/sync.js"), "utf8");

describe("Sync page operations — isolated fake-provider UI", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    const cache = path.join(USERDATA, "empty-browser-cache"); fs.mkdirSync(cache);
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData: false, env: { AGENT_BROWSER_CHROMIUM_CACHE_DIR: cache } });
  }, 90000);
  afterAll(async () => {
    if (h) await closeApp(h);
    if (path.dirname(USERDATA) !== os.tmpdir() || !path.basename(USERDATA).startsWith("ui-goal-sync-e2e-")) throw new Error("Unsafe Sync E2E cleanup");
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90000);
  beforeEach(async () => {
    await h.page.evaluate(() => {
      const ab = (window as any).agentBrowser;
      const section = (ids: string[] = []) => ({ localOnly: [], remoteOnly: [], changed: ids.map((id) => ({ id, fields: ["name"] })) });
      const fixture = (id = "fixture_profile") => ({ ok: true, profiles: section([id]), proxies: section(["fixture_proxy"]), accounts: section(["fixture_account"]), extensions: section(), pushWarnings: [], pullNotes: [] });
      const state = { pulls: [] as any[], pushes: [] as any[], diff: fixture(), pending: [] as Array<{ resolve: (r: any) => void; reject: (e: Error) => void }>, fixture };
      (window as any).__syncGoalFixture = state;
      // The contextBridge API is frozen. Use a mutable fixture bridge and
      // re-load the complete owned module so its closure captures that bridge.
      ab.api = { ...ab.api, team: { ...ab.api.team }, sync: {
        preview: async () => ({ configured: true, runningProfiles: [] }),
        previewDiff: async () => state.diff,
        pull: async (opts: any) => { state.pulls.push(opts); return { success: false, message: "Synthetic Pull (no write)" }; },
        push: async (opts: any) => { state.pushes.push(opts || {}); return { success: false, message: "Synthetic Push (no write)" }; },
        status: async () => ({ enabled: false, endpoint: "", bucket: "", configured: false }),
        configure: async () => ({ success: false, error: "Synthetic configure disabled" }),
      } };
      ab.api.team.status = async () => ({ team: null, local: { deviceId: "fixture_device", role: "owner" } });
      for (const key of ["init", "addMember", "removeMember", "setRole", "rename", "setEnabled"]) {
        ab.api.team[key] = async () => { throw new Error("Synthetic team write disabled"); };
      }
      (document.getElementById("sync-merge-strategy") as HTMLSelectElement).value = "local";
    });
    await h.page.addScriptTag({ content: SOURCE });
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("sync"));
  });
  it("untouched conflicts follow global; explicitly selecting the former default remains an override", async () => {
    await h.page.click('[data-cmd="loadSyncDiff"]');
    await h.page.waitForSelector('#sync-diff .sync-entry-strategy[data-section="profiles"]');
    const entries = h.page.locator("#sync-diff .sync-entry-strategy");
    expect(await entries.first().inputValue()).toBe("");
    await h.page.selectOption("#sync-merge-strategy", "remote");
    await h.page.click('[data-cmd="syncPull"]');
    await h.page.waitForFunction(() => (window as any).__syncGoalFixture.pulls.length === 1);
    expect(await h.page.evaluate(() => (window as any).__syncGoalFixture.pulls[0])).toEqual({ strategy: "remote", resolutions: {} });
    await entries.first().selectOption("local");
    await h.page.selectOption("#sync-merge-strategy", "newest");
    await h.page.click('[data-cmd="syncPull"]');
    await h.page.waitForFunction(() => (window as any).__syncGoalFixture.pulls.length === 2);
    expect(await h.page.evaluate(() => (window as any).__syncGoalFixture.pulls[1])).toEqual({ strategy: "newest", resolutions: { "profiles:fixture_profile": "local" } });
    await entries.first().selectOption("");
    await h.page.click('[data-cmd="syncPull"]');
    await h.page.waitForFunction(() => (window as any).__syncGoalFixture.pulls.length === 3);
    expect(await h.page.evaluate(() => (window as any).__syncGoalFixture.pulls[2].resolutions)).toEqual({});
  });
  it("failed preflight blocks Push, first-push passes and releases the button", async () => {
    await h.page.evaluate(() => { (window as any).__syncGoalFixture.diff = { ok: false, message: "Synthetic comparison denied" }; });
    await h.page.click('[data-cmd="syncPush"]');
    await h.page.waitForFunction(() => !(document.querySelector('[data-cmd="syncPush"]') as HTMLButtonElement).disabled);
    expect(await h.page.evaluate(() => (window as any).__syncGoalFixture.pushes)).toEqual([]);
    expect(await h.page.locator("#sync-diff-message").textContent()).toContain("Synthetic comparison denied");
    await h.page.evaluate(() => { const s = (window as any).__syncGoalFixture; s.diff = { ...s.fixture(), firstPush: true }; });
    await h.page.click('[data-cmd="syncPush"]');
    await h.page.waitForFunction(() => (window as any).__syncGoalFixture.pushes.length === 1);
    await h.page.waitForFunction(() => !(document.querySelector('[data-cmd="syncPush"]') as HTMLButtonElement).disabled);
  });
  it("warning Cancel produces no Push and restores the initiating control", async () => {
    await h.page.evaluate(() => { (window as any).__syncGoalFixture.diff.pushWarnings = ["Remove synthetic remote profile"]; });
    await h.page.click('[data-cmd="syncPush"]');
    await h.page.waitForSelector("#dlg-confirm[open]");
    expect(await h.page.locator("#dlg-confirm-ack").isVisible()).toBe(true);
    await h.page.click('#dlg-confirm [data-cmd="close-dialog"]');
    await h.page.waitForFunction(() => !(document.querySelector('[data-cmd="syncPush"]') as HTMLButtonElement).disabled);
    expect(await h.page.evaluate(() => (window as any).__syncGoalFixture.pushes)).toEqual([]);
  });
  for (const rejection of [false, true]) {
    it(`latest comparison wins over late ${rejection ? "rejection" : "success"}`, async () => {
      await h.page.evaluate(() => {
        const ab = (window as any).agentBrowser, s = (window as any).__syncGoalFixture;
        ab.api.sync.previewDiff = () => new Promise((resolve, reject) => s.pending.push({ resolve, reject }));
      });
      await h.page.click('[data-cmd="loadSyncDiff"]');
      await h.page.click('[data-cmd="loadSyncDiff"]');
      await h.page.waitForFunction(() => (window as any).__syncGoalFixture.pending.length === 2);
      await h.page.evaluate(() => { const s = (window as any).__syncGoalFixture; s.pending[1].resolve(s.fixture("new_fixture")); });
      await h.page.waitForSelector('#sync-diff .sync-entry-strategy[data-id="new_fixture"]');
      await h.page.evaluate((reject) => {
        const s = (window as any).__syncGoalFixture;
        if (reject) s.pending[0].reject(new Error("Synthetic obsolete rejection")); else s.pending[0].resolve(s.fixture("old_fixture"));
      }, rejection);
      // Drain two animation frames so native DOM callbacks and promise rendering settle.
      await h.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await h.page.locator('#sync-diff .sync-entry-strategy[data-id="new_fixture"]').count()).toBe(1);
      expect(await h.page.locator('#sync-diff .sync-entry-strategy[data-id="old_fixture"]').count()).toBe(0);
    });
  }
  it("rejected role/enforcement writes restore the status controls", async () => {
    await h.page.evaluate(() => {
      const ab = (window as any).agentBrowser;
      ab.api.team.status = async () => ({ team: { name: "Synthetic", enabled: true, ownerDeviceId: "fixture_device", members: [{ deviceId: "fixture_device", role: "owner" }, { deviceId: "other_fixture", role: "member" }] }, local: { deviceId: "fixture_device", role: "owner" } });
      ab.loadTeamPanel();
    });
    await h.page.waitForSelector('.team-role-select[data-device-id="other_fixture"]');
    await h.page.selectOption('.team-role-select[data-device-id="other_fixture"]', "viewer");
    await h.page.waitForFunction(() => (document.querySelector('.team-role-select[data-device-id="other_fixture"]') as HTMLSelectElement).value === "member");
    await h.page.uncheck("#team-enabled");
    await h.page.waitForFunction(() => (document.getElementById("team-enabled") as HTMLInputElement).checked);
  });
  it("no page-level errors", () => { expect(h.pageErrors).toEqual([]); });
});
