// J55: Post-launch fingerprint drift block (Slice 19, P0). A stored baseline
// that stops matching the live fingerprint on high-risk fields blocks the
// launch by default (and kills the child); the read-only check-drift IPC
// reports it; disabling blockOnFingerprintDrift lets the launch proceed with
// a risky warning.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j55");

describe("J55 — fingerprint drift block on launch", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J55", platform: "windows", fingerprintSeed: 51515 }));
    dirId = r.dirId;
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  async function launch(): Promise<any> {
    return h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.launch(id), dirId);
  }
  async function stop(): Promise<void> {
    await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId);
      if (!st.running) break;
      await h.page.waitForTimeout(300);
    }
  }

  it("launches without a baseline (no drift check)", async () => {
    const r = await launch();
    expect(r.success).toBe(true);
    expect(r.driftCheck).toEqual({ checked: false });
    await stop();
  }, 60000);

  it("captures a baseline and the read-only check reports stable", async () => {
    await launch();
    const cap = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.captureBaseline(id), dirId);
    expect(cap.ok).toBe(true);
    const chk = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.checkDrift(id), dirId);
    expect(chk.ok).toBe(true);
    expect(chk.hasBaseline).toBe(true);
    expect(chk.risky).toBe(false);
    await stop();
  }, 60000);

  it("blocks a launch whose baseline drifted on a high-risk field", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    cfg.browserProfiles[dirId].fingerprintBaseline = { ...cfg.browserProfiles[dirId].fingerprintBaseline, userAgent: "DRIFT-BLOCK-TEST" };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const r = await launch();
    expect(r.success).toBe(false);
    expect(r.error).toContain("Fingerprint drift blocked");
    // The drifted child must not be left running after the block.
    const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId);
    expect(st.running).toBe(false);
  }, 60000);

  it("audits the drift block", async () => {
    const entries: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ limit: 50 }));
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.some((e) => e.action === "fingerprint-drift-block" && e.target === dirId)).toBe(true);
  }, 20000);

  it("launch proceeds with a risky warning when blocking is disabled", async () => {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    cfg.blockOnFingerprintDrift = false;
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const r = await launch();
    expect(r.success).toBe(true);
    expect(r.driftCheck.checked).toBe(true);
    expect(r.driftCheck.risky).toBe(true);
    await stop();
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});

