// PREPARED ONLY: run during coordinator SERIAL native acceptance, not in Node checks.
// Real Electron DOM + IPC/config/profile bytes. No browser profile launch, risk
// check, clipboard, keychain, external page, real user data or activation code.
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";
import { closeAllDialogs } from "./helpers/diag.js";

const PROGRESS = "agent-browser-studio-wizard-progress";

describe("F15/F10 — wizard resume and unavailable activation (serial native acceptance)", () => {
  let h: TestAppHandle;
  let owned: string;
  let userdata: string;
  let evidenceRoot: string;
  let createdId: string;
  const name = "UI goal synthetic first profile";

  beforeAll(async () => {
    // Explicit read-only engine fixture only: no host cache discovery/download.
    // Verification is permitted only when the coordinator runs native acceptance.
    const fixture = process.env.UI_GOAL_CHROMIUM_FIXTURE;
    if (!fixture || !fs.statSync(fixture).isFile()) throw new Error("SERIAL acceptance requires UI_GOAL_CHROMIUM_FIXTURE executable path");
    owned = fs.mkdtempSync(path.join(os.tmpdir(), "ui-goal-wizard-license-native-"));
    // Outside userdata's disposable root: retain screenshots/bytes even on failure.
    const evidenceParent = process.env.UI_GOAL_NATIVE_EVIDENCE_DIR || os.tmpdir();
    fs.mkdirSync(evidenceParent, { recursive: true });
    evidenceRoot = fs.mkdtempSync(path.join(evidenceParent, "wizard-license-native-evidence-"));
    userdata = path.join(owned, "userdata");
    h = await setupTestApp({ userDataDir: userdata, env: {
      AGENT_BROWSER_CHROMIUM_BINARY_PATH: path.resolve(fixture),
      // Deliberately unusable public-key fixture (not a release key/license).
      // It prevents resource/env key lookup while exercising real IPC readiness.
      AGENT_BROWSER_LICENSE_PUBKEY: "synthetic-invalid-public-key",
    } });
    await h.page.evaluate(() => {
      localStorage.setItem("agent-browser-studio-terms-accepted-v1", "1");
      localStorage.removeItem("agent-browser-studio-wizard-dismissed");
      localStorage.removeItem("cloak-wizard-dismissed");
      localStorage.removeItem("agent-browser-studio-wizard-progress");
      (window as any).wizardDismissed = false;
    });
  }, 90_000);

  afterAll(async () => {
    try {
      if (owned && evidenceRoot) {
        for (const lang of ["en-US", "zh-CN"]) {
          const shot = path.join(owned, `license-unavailable-${lang}.png`);
          if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(evidenceRoot, path.basename(shot)));
        }
        for (const file of ["config.json", "license.json"]) {
          const source = path.join(userdata, file);
          if (fs.existsSync(source)) fs.copyFileSync(source, path.join(evidenceRoot, file));
        }
        fs.writeFileSync(path.join(evidenceRoot, "native-status.json"), JSON.stringify({ pageErrors: h?.pageErrors, consoleErrors: h?.consoleErrors, userdata, evidenceRoot }));
      }
    } finally {
      try { if (h) await closeApp(h); }
      finally { if (owned) fs.rmSync(owned, { recursive: true, force: true }); }
    }
  }, 90_000);

  it("restores editable step 2, creates one actual profile after two submissions, and resumes after renderer reload", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.showWizard());
    await h.page.locator('#dlg-wizard [data-cmd="wizardVerifyBinary"]').click();
    await h.page.waitForFunction(() => !(document.getElementById("wizard-profile-name") as HTMLInputElement).disabled);
    expect(JSON.parse((await h.page.evaluate(k => localStorage.getItem(k), PROGRESS))!)).toMatchObject({ step: 1, dirId: null });
    await h.page.reload();
    await h.page.waitForFunction(() => (document.getElementById("dlg-wizard") as HTMLDialogElement).open && !(document.getElementById("wizard-profile-name") as HTMLInputElement).disabled);
    await h.page.locator("#wizard-profile-name").fill(name);
    await h.page.evaluate(() => { const a = (window as any).agentBrowser; a.wizardCreateProfile(); a.wizardCreateProfile(); });
    await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.wizardDirId);
    createdId = await h.page.evaluate(() => (window as any).agentBrowser.state.wizardDirId);
    const disk = JSON.parse(fs.readFileSync(path.join(userdata, "config.json"), "utf8"));
    expect(Object.keys(disk.browserProfiles)).toEqual([createdId]);
    expect(disk.browserProfiles[createdId].name).toBe(name);
    expect(fs.statSync(path.join(userdata, "profiles", createdId, "Default")).isDirectory()).toBe(true);
    const checkpoint = JSON.parse((await h.page.evaluate(k => localStorage.getItem(k), PROGRESS))!);
    expect(checkpoint).toMatchObject({ step: 2, dirId: createdId, profileName: name });
    await h.page.reload();
    await h.page.waitForFunction(id => (document.getElementById("dlg-wizard") as HTMLDialogElement).open && (window as any).agentBrowser.state.wizardDirId === id, createdId);
    const readback = await h.page.evaluate(async id => {
      const api = (window as any).agentBrowser.api;
      return { binary: await api.browser.binary(), list: await api.browser.list(), profile: await api.profile.get(id), status: await api.browser.status(id) };
    }, createdId);
    expect(readback.binary.installed).toBe(true); // Genuine engine + profile checkpoint case.
    expect(readback.list.map((p: any) => p.dirId)).toEqual([createdId]);
    expect(readback.list.filter((p: any) => p.name.includes("synthetic")).map((p: any) => p.dirId)).toEqual([createdId]);
    expect(readback.profile.dirId).toBe(createdId);
    expect(readback.status.running).toBe(false);
    expect(await h.page.locator('#dlg-wizard [data-cmd="wizardCreateProfile"]').isDisabled()).toBe(true);
    expect(await h.page.locator('#dlg-wizard [data-cmd="wizardLaunchAndCheck"]').isEnabled()).toBe(true);
    expect(h.pageErrors).toEqual([]);
  }, 90_000);

  it("does not restore a ghost target and retains the actual profile/config bytes", async () => {
    await closeAllDialogs(h.page);
    const bytes = fs.readFileSync(path.join(userdata, "config.json"));
    await h.page.evaluate(k => {
      localStorage.setItem(k, JSON.stringify({ step: 3, dirId: "synthetic-ghost", profileName: "gone" }));
      (window as any).wizardDismissed = false;
      (window as any).agentBrowser.showWizard();
    }, PROGRESS);
    await h.page.waitForFunction(() => !(document.getElementById("wizard-profile-name") as HTMLInputElement).disabled);
    expect(await h.page.evaluate(() => (window as any).agentBrowser.state.wizardDirId)).toBeNull();
    expect(await h.page.locator('#dlg-wizard [data-cmd="wizardLaunchAndCheck"]').isDisabled()).toBe(true);
    expect(JSON.parse((await h.page.evaluate(k => localStorage.getItem(k), PROGRESS))!)).toMatchObject({ step: 1, dirId: null });
    expect(fs.readFileSync(path.join(userdata, "config.json"))).toEqual(bytes);
    expect(await h.page.evaluate(id => (window as any).agentBrowser.api.browser.status(id), createdId)).toMatchObject({ running: false });
  });

  it("real IPC reports trial-only readiness and native dialog disables activation without any license mutation", async () => {
    await closeAllDialogs(h.page);
    const status = await h.page.evaluate(() => (window as any).agentBrowser.api.license.status());
    expect(status).toMatchObject({ plan: "trial", canActivate: false, expired: false });
    const file = path.join(userdata, "license.json");
    const bytes = fs.readFileSync(file);
    expect(JSON.parse(bytes.toString()).payload).toBeUndefined();
    await h.page.evaluate(() => (window as any).agentBrowser.showLicenseDialog());
    await vi.waitFor(async () => {
      expect(await h.page.locator("#license-activate-btn").isDisabled()).toBe(true);
      expect(await h.page.locator("#license-code-input").isDisabled()).toBe(true);
      expect(await h.page.locator("#license-error").isVisible()).toBe(true);
      expect(await h.page.evaluate(() => (window as any).agentBrowser.licenseStatus()?.canActivate)).toBe(false);
    });
    for (const lang of ["en-US", "zh-CN"]) {
      await h.page.evaluate(language => (window as any).i18n.set(language), lang);
      await h.page.evaluate(() => (window as any).agentBrowser.showLicenseDialog());
      await vi.waitFor(async () => expect(await h.page.locator("#license-error").textContent()).toBe(lang === "en-US" ? "This build cannot verify licenses (trial only)." : "此版本无法校验授权（仅试用）。"));
      await h.page.screenshot({ path: path.join(owned, `license-unavailable-${lang}.png`) });
    }
    expect(fs.readFileSync(file)).toEqual(bytes);
    await h.page.locator('#dlg-license [data-cmd="close-dialog"]').click();
    expect(await h.page.locator("#dlg-license").isVisible()).toBe(false);
    expect(h.pageErrors).toEqual([]);
  });

  for (const ordering of ["reopen-before-reply", "reply-while-closed"]) {
    it(`reconciles actual committed creation ${ordering} without a second actual mutation`, async () => {
      await h.page.reload(); await closeAllDialogs(h.page);
      const profileName = `Native committed receipt ${ordering}`;
      const before = JSON.parse(fs.readFileSync(path.join(userdata, "config.json"), "utf8"));
      await h.page.evaluate(({ key, profileName }) => {
        const a = (window as any).agentBrowser, w = window as any;
        const original = a.api.browser.create;
        w.__wizardReceiptProbe = { original, calls: 0, committed: null, release: null };
        a.api.browser.create = async (params: any) => {
          w.__wizardReceiptProbe.calls++;
          const result = await original(params); // Genuine IPC mutation, only the reply is delayed.
          w.__wizardReceiptProbe.committed = result;
          return new Promise(resolve => { w.__wizardReceiptProbe.release = () => resolve(result); });
        };
        localStorage.setItem(key, JSON.stringify({ step: 1 }));
        a.showWizard(); (document.getElementById("wizard-profile-name") as HTMLInputElement).value = profileName;
        a.wizardCreateProfile(); a.wizardCreateProfile();
      }, { key: PROGRESS, profileName });
      try {
        await h.page.waitForFunction(() => !!(window as any).__wizardReceiptProbe.release);
        const id = await h.page.evaluate(() => (window as any).__wizardReceiptProbe.committed.dirId);
        expect(typeof id).toBe("string");
        const file = path.join(userdata, "config.json"), committedBytes = fs.readFileSync(file);
        const committed = JSON.parse(committedBytes.toString());
        expect(Object.keys(committed.browserProfiles).sort()).toEqual([...Object.keys(before.browserProfiles), id].sort());
        expect(committed.browserProfiles[id].name).toBe(profileName);
        expect(fs.statSync(path.join(userdata, "profiles", id, "Default")).isDirectory()).toBe(true);
        await h.page.evaluate(reopen => {
          (document.getElementById("dlg-wizard") as HTMLDialogElement).close();
          if (reopen) (window as any).agentBrowser.showWizard();
        }, ordering === "reopen-before-reply");
        if (ordering === "reopen-before-reply") expect(await h.page.locator('#dlg-wizard [data-cmd="wizardCreateProfile"]').isDisabled()).toBe(true);
        await h.page.evaluate(() => (window as any).__wizardReceiptProbe.release());
        if (ordering === "reply-while-closed") {
          await h.page.waitForFunction(k => JSON.parse(localStorage.getItem(k)!).step === 2, PROGRESS);
          expect(await h.page.evaluate(() => (document.getElementById("dlg-wizard") as HTMLDialogElement).open)).toBe(false);
          await h.page.evaluate(() => (window as any).agentBrowser.showWizard());
        }
        await h.page.waitForFunction(id => (window as any).agentBrowser.state.wizardDirId === id, id);
        await h.page.evaluate(() => (window as any).agentBrowser.wizardCreateProfile());
        expect(await h.page.evaluate(() => (window as any).__wizardReceiptProbe.calls)).toBe(1);
        expect(await h.page.locator('#dlg-wizard [data-cmd="wizardCreateProfile"]').isDisabled()).toBe(true);
        expect(await h.page.locator('#dlg-wizard [data-cmd="wizardLaunchAndCheck"]').isEnabled()).toBe(true);
        expect(fs.readFileSync(file)).toEqual(committedBytes);
        const checkpoint = JSON.parse((await h.page.evaluate(k => localStorage.getItem(k), PROGRESS))!);
        expect(checkpoint).toMatchObject({ step: 2, dirId: id, profileName });
        await h.page.screenshot({ path: path.join(evidenceRoot, `${ordering}.png`) });
        fs.writeFileSync(path.join(evidenceRoot, `${ordering}-config.json`), committedBytes);
        fs.writeFileSync(path.join(evidenceRoot, `${ordering}-receipt.json`), JSON.stringify({ id, profileName, checkpoint }));
        await h.page.reload();
        await h.page.waitForFunction(id => (window as any).agentBrowser.state.wizardDirId === id, id);
        const readback = await h.page.evaluate(async ({ id, profileName }) => {
          const api = (window as any).agentBrowser.api, list = await api.browser.list();
          return { profile: await api.profile.get(id), list, search: list.filter((p: any) => p.name === profileName).map((p: any) => p.dirId) };
        }, { id, profileName });
        expect(readback.profile.dirId).toBe(id); expect(readback.search).toEqual([id]);
        expect(readback.list.map((p: any) => p.dirId).sort()).toEqual(Object.keys(committed.browserProfiles).sort());
        expect(fs.readFileSync(file)).toEqual(committedBytes);
      } finally {
        await h.page.evaluate(() => {
          const w = window as any;
          if (w.__wizardReceiptProbe) { w.agentBrowser.api.browser.create = w.__wizardReceiptProbe.original; delete w.__wizardReceiptProbe; }
        });
      }
      expect(h.pageErrors).toEqual([]);
    }, 90_000);
  }

  for (const ordering of ["older-first", "newer-first"]) {
    for (const latest of ["ready", "unavailable", "error"]) {
      it(`controlled native dialog status ${latest}/${ordering} updates live controls without activation`, async () => {
        await closeAllDialogs(h.page);
        const file = path.join(userdata, "license.json"), bytes = fs.readFileSync(file);
        await h.page.evaluate(() => {
          const a = (window as any).agentBrowser, w = window as any, original = a.api.license.status;
          w.__licenseRaceProbe = { original, requests: [] };
          a.api.license.status = () => new Promise((resolve, reject) => w.__licenseRaceProbe.requests.push({ resolve, reject }));
          a.showLicenseDialog();
        });
        try {
          await h.page.waitForFunction(() => (window as any).__licenseRaceProbe.requests.length === 1);
          await h.page.evaluate(() => { (window as any).agentBrowser.refreshLicense(); });
          await h.page.waitForFunction(() => (window as any).__licenseRaceProbe.requests.length === 2);
          await h.page.evaluate(({ ordering, latest }) => {
            const probe = (window as any).__licenseRaceProbe;
            const old = () => probe.requests[0].resolve({ plan: "trial", canActivate: latest !== "ready", deviceId: "stale-controlled-device" });
            const current = () => latest === "error" ? probe.requests[1].reject(new Error("controlled status failure")) : probe.requests[1].resolve({ plan: "trial", canActivate: latest === "ready", deviceId: "latest-controlled-device" });
            if (ordering === "older-first") { old(); queueMicrotask(current); } else { current(); queueMicrotask(old); }
          }, { ordering, latest });
          await vi.waitFor(async () => {
            expect(await h.page.locator("#license-activate-btn").isDisabled()).toBe(latest !== "ready");
            expect(await h.page.locator("#license-code-input").isDisabled()).toBe(latest !== "ready");
            expect(await h.page.locator("#license-device-id").textContent()).toBe(latest === "error" ? "—" : "latest-controlled-device");
          });
          expect(await h.page.locator("#license-refund-ack").isChecked()).toBe(false);
          expect(await h.page.evaluate(() => (document.getElementById("dlg-license") as HTMLDialogElement).open)).toBe(true);
          // Renderer/provider truth fixture only: no activation request or code is sent.
          if (latest === "ready") {
            await h.page.locator("#license-code-input").fill("controlled input only");
            await h.page.locator("#license-refund-ack").check();
            await h.page.evaluate(() => { (window as any).agentBrowser.refreshLicense(); });
            await h.page.waitForFunction(() => (window as any).__licenseRaceProbe.requests.length === 3);
            await h.page.evaluate(() => (window as any).__licenseRaceProbe.requests[2].resolve({ plan: "trial", canActivate: false, deviceId: "latest-controlled-device" }));
            await vi.waitFor(async () => expect(await h.page.locator("#license-code-input").isDisabled()).toBe(true));
            expect(await h.page.locator("#license-code-input").inputValue()).toBe("controlled input only");
            expect(await h.page.locator("#license-refund-ack").isChecked()).toBe(true);
          }
          await h.page.screenshot({ path: path.join(evidenceRoot, `status-${latest}-${ordering}.png`) });
          expect(fs.readFileSync(file)).toEqual(bytes);
          await h.page.evaluate(() => { (document.getElementById("dlg-license") as HTMLDialogElement).close(); });
          expect(await h.page.evaluate(() => (document.getElementById("dlg-license") as HTMLDialogElement).open)).toBe(false);
        } finally {
          await h.page.evaluate(() => {
            const w = window as any; w.agentBrowser.api.license.status = w.__licenseRaceProbe.original; delete w.__licenseRaceProbe;
          });
          await h.page.evaluate(() => (window as any).agentBrowser.refreshLicense());
        }
        expect(h.pageErrors).toEqual([]);
      });
    }
  }

  it("controlled native late profile count cannot overwrite expired truth", async () => {
    await closeAllDialogs(h.page);
    const file = path.join(userdata, "license.json"), bytes = fs.readFileSync(file);
    await h.page.evaluate(async () => {
      const a = (window as any).agentBrowser, w = window as any;
      w.__bannerRaceProbe = { status: a.api.license.status, list: a.api.browser.list, releases: [] };
      a.api.browser.list = () => new Promise(resolve => { w.__bannerRaceProbe.releases.push(resolve); });
      a.api.license.status = async () => ({ plan: "trial", daysLeft: 14, maxProfiles: 10, expired: false, canActivate: false });
      await a.refreshLicense();
      a.api.license.status = async () => ({ plan: "trial", daysLeft: 0, maxProfiles: 10, expired: true, canActivate: false });
      await a.refreshLicense();
    });
    try {
      const expired = await h.page.locator("#license-banner").textContent();
      await h.page.evaluate(() => (window as any).__bannerRaceProbe.releases[0]([{ dirId: "controlled", name: "controlled" }]));
      expect(await h.page.locator("#license-banner").textContent()).toBe(expired);
      expect(await h.page.evaluate(() => (window as any).agentBrowser.licenseStatus().expired)).toBe(true);
      expect(fs.readFileSync(file)).toEqual(bytes);
      await h.page.screenshot({ path: path.join(evidenceRoot, "late-usage-expired.png") });
    } finally {
      await h.page.evaluate(() => {
        const w = window as any, a = w.agentBrowser, p = w.__bannerRaceProbe;
        a.api.license.status = p.status; a.api.browser.list = p.list; delete w.__bannerRaceProbe;
      });
      await h.page.evaluate(() => (window as any).agentBrowser.refreshLicense());
    }
  });

  it("controlled native risk success after Skip cannot resurrect a checkpoint or perform external work", async () => {
    await closeAllDialogs(h.page);
    const file = path.join(userdata, "config.json"), bytes = fs.readFileSync(file);
    await h.page.evaluate(async ({ key, id }) => {
      const a = (window as any).agentBrowser, w = window as any;
      w.__riskRaceProbe = { consent: a.ensureExternalRiskConsent, status: a.api.browser.status, risk: a.api.browser.openRiskCheck, calls: 0, release: null };
      a.ensureExternalRiskConsent = (_id: string, cb: () => void) => cb(); // Controlled consent gateway only.
      a.api.browser.status = async () => ({ running: true });
      a.api.browser.openRiskCheck = () => { w.__riskRaceProbe.calls++; return new Promise(resolve => { w.__riskRaceProbe.release = resolve; }); };
      localStorage.setItem(key, JSON.stringify({ step: 2, dirId: id })); a.showWizard();
    }, { key: PROGRESS, id: createdId });
    try {
      await h.page.waitForFunction(() => !!(window as any).agentBrowser.state.wizardDirId);
      await h.page.evaluate(() => (window as any).agentBrowser.wizardLaunchAndCheck());
      await h.page.waitForFunction(() => !!(window as any).__riskRaceProbe.release);
      await h.page.evaluate(() => { const w = window as any; w.agentBrowser.wizardSkip(); w.__riskRaceProbe.release({ success: true }); });
      expect(await h.page.evaluate(k => localStorage.getItem(k), PROGRESS)).toBeNull();
      expect(await h.page.evaluate(() => (document.getElementById("dlg-wizard") as HTMLDialogElement).open)).toBe(false);
      expect(await h.page.evaluate(() => (window as any).__riskRaceProbe.calls)).toBe(1);
      expect(fs.readFileSync(file)).toEqual(bytes);
      await h.page.screenshot({ path: path.join(evidenceRoot, "risk-after-skip.png") });
    } finally {
      await h.page.evaluate(() => {
        const w = window as any, a = w.agentBrowser, p = w.__riskRaceProbe;
        a.ensureExternalRiskConsent = p.consent; a.api.browser.status = p.status; a.api.browser.openRiskCheck = p.risk; delete w.__riskRaceProbe;
      });
    }
    expect(h.pageErrors).toEqual([]);
  });
});
