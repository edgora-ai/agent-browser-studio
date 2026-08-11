// J40: Structured data export (Slice 9). data:export returns stable JSON for
// profiles/db (and more), and never leaks secrets.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j40");

describe("J40 — structured data export", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    await h.page.evaluate(async () => (window as any).agentBrowser.api.browser.create({ name: "J40", platform: "windows", fingerprintSeed: 40404, tags: ["audit", "eval"] }));
    await h.page.evaluate(async () => {
      await (window as any).agentBrowser.api.proxy.add("j40-auth", { type: "http", host: "8.8.8.8", port: 8080, username: "user", password: "test-proxy-password-not-real" });
    });
    const cfgPath = path.join(USERDATA, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.proxyDetections = {
      ...(cfg.proxyDetections || {}),
      "j40-auth": { detectedAt: 1700000000000, success: true, exitIp: "8.8.8.8", country: "United States", countryCode: "US", timezone: "America/New_York", provider: "unit", latencyMs: 42, error: null },
    };
    cfg.agentRuns = [
      ...(cfg.agentRuns || []),
      { id: "run_j40vars", name: "J40 vars", source: { type: "chat" }, status: "done", startedAt: 1700000000100, finishedAt: 1700000000200, steps: [], variables: { token: "test-run-variable-secret-not-real" } },
    ];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await h.page.evaluate(async () => (window as any).agentBrowser.api.app.reloadConfig());
    await h.page.evaluate(async () => { await (window as any).agentBrowser.api.agentDb.exec("CREATE TABLE IF NOT EXISTS export_t (id INTEGER PRIMARY KEY, v TEXT)"); });
    await h.page.evaluate(async () => { await (window as any).agentBrowser.api.agentDb.exec("INSERT INTO export_t (v) VALUES ('hello-export')"); });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("exports profiles + db in the 'all' scope", async () => {
    const res = await h.page.evaluate(() => (window as any).agentBrowser.api.data.export("all"));
    expect(res.ok).toBe(true);
    expect(res.scope).toBe("all");
    expect(res.data.profiles.length).toBeGreaterThanOrEqual(1);
    expect(res.data.profiles.some((p: any) => p.name === "J40")).toBe(true);
    const t = (res.data.db || []).find((x: any) => x.name === "export_t");
    expect(t, "export_t table metadata must be exported").toBeTruthy();
    expect(t.rowCount).toBeGreaterThanOrEqual(1);
    expect(t.rows).toBeUndefined();
  });

  it("exports redacted proxy detections and profile tags", async () => {
    const res = await h.page.evaluate(() => (window as any).agentBrowser.api.data.export("all"));
    const profile = res.data.profiles.find((p: any) => p.name === "J40");
    expect(profile.tags).toEqual(["audit", "eval"]);
    expect(res.data.proxies["j40-auth"].hasPassword).toBe(true);
    expect(res.data.proxies["j40-auth"].password).toBeUndefined();
    expect(res.data.proxies["j40-auth"].detection.countryCode).toBe("US");
    expect(res.data.proxyDetections["j40-auth"].exitIp).toBe("8.8.8.8");
    const run = res.data.runs.find((r: any) => r.id === "run_j40vars");
    expect(run.variableKeys).toEqual(["token"]);
    expect(run.variables).toBeUndefined();
  });

  it("a scoped export only returns that scope", async () => {
    const res = await h.page.evaluate(() => (window as any).agentBrowser.api.data.export("db"));
    expect(res.data.db).toBeTruthy();
    expect(res.data.profiles).toBeUndefined();
  });

  it("never exports secrets", async () => {
    const res = await h.page.evaluate(() => (window as any).agentBrowser.api.data.export("all"));
    const blob = JSON.stringify(res);
    expect(blob).not.toContain("test-proxy-password-not-real");
    expect(blob).not.toContain("test-run-variable-secret-not-real");
    expect(blob).not.toMatch(/apiKey|secretKey/i);
  });

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
