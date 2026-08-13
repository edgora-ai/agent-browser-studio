// J59: Environment-risk launch gate (Slice 23). Launching a non-CN profile on
// a host with CN resolvers/fonts (verified on the dev machine) returns an
// envCheck with high findings; with blockOnEnvironmentRisk=true the launch is
// refused and the child is killed; audits record both.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j59");

describe("J59 — environment risk launch gate", () => {
  let h: TestAppHandle;
  let dirId = "";

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    const r = await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J59", platform: "windows", locale: "en-US", timezone: "America/New_York", fingerprintSeed: 11111, proxyMode: "none" }));
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
  async function setConfig(patch: Record<string, unknown>): Promise<void> {
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    Object.assign(cfg, patch);
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());
  }

  it("launch returns a checked envCheck with high findings (warn-only by default)", async () => {
    const r = await launch();
    expect(r.success).toBe(true);
    expect(r.envCheck).toBeTruthy();
    expect(r.envCheck.checked).toBe(true);
    expect(r.envCheck.high).toBe(true);
    expect(Array.isArray(r.envCheck.findings)).toBe(true);
    expect(r.envCheck.findings.some((f: any) => f.severity === "high")).toBe(true);
    await stop();
  }, 60000);

  it("audits the high environment findings", async () => {
    const entries: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ limit: 50 }));
    expect(entries.some((e) => e.action === "env-risk-high" && e.target === dirId)).toBe(true);
  }, 20000);

  it("blocks launch when blockOnEnvironmentRisk is enabled", async () => {
    await setConfig({ blockOnEnvironmentRisk: true });
    const r = await launch();
    expect(r.success).toBe(false);
    expect(r.error).toContain("Environment risk blocked");
    const st = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.status(id), dirId);
    expect(st.running).toBe(false);
  }, 60000);

  it("audits the env-risk block", async () => {
    const entries: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.audit.list({ limit: 80 }));
    expect(entries.some((e) => e.action === "env-risk-block" && e.target === dirId)).toBe(true);
  }, 20000);

  it("launch proceeds once blocking is disabled", async () => {
    await setConfig({ blockOnEnvironmentRisk: false });
    const r = await launch();
    expect(r.success).toBe(true);
    expect(r.envCheck.high).toBe(true);
    await stop();
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
