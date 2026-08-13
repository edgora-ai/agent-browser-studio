// J65: Proxy bulk import/export. Opens the 📥 导入代理 dialog, pastes a mixed
// list (URI lines + CSV header), imports, verifies cards + config on disk, then
// exports via the CSV API and checks the document contents.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j65");

describe("J65 — proxy bulk import / export", () => {
  let h: TestAppHandle;

  beforeAll(async () => { h = await setupTestApp({ userDataDir: USERDATA }); }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("imports a mixed URI + CSV list through the dialog", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("proxy"));
    await h.page.waitForTimeout(300);
    await h.page.locator('[data-cmd="importProxies"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy-import[open]", { timeout: 5000 });
    const list =
      "name,type,host,port,username,password\n" +
      "bulk-us,socks5,1.2.3.4,1080,alice,secret\n" +
      "socks5h://bob:p%40ss@5.6.7.8:1080\n" +
      "9.9.9.9:8080\n" +
      "# comment line\n" +
      "not-a-valid-line";
    await h.page.locator("#dlg-proxy-import-text").fill(list);
    await h.page.evaluate(() => (window as any).agentBrowser.doImportProxies());
    await h.page.waitForTimeout(900);
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    expect(cfg.proxies["bulk-us"]).toMatchObject({ type: "socks5", host: "1.2.3.4", port: 1080, username: "alice" });
    expect(cfg.proxies["bulk-us"].password).toBeTruthy(); // encrypted at rest
    expect(cfg.proxies["5.6.7.8-1080"]).toMatchObject({ type: "socks5h", host: "5.6.7.8", port: 1080, username: "bob" });
    expect(cfg.proxies["5.6.7.8-1080"].password).toBeTruthy();
    expect(cfg.proxies["9.9.9.9-8080"]).toMatchObject({ type: "http", host: "9.9.9.9", port: 8080 });
    await h.page.waitForSelector('#proxy-list [data-proxy-name="bulk-us"]', { timeout: 5000 });
    await h.page.waitForSelector('#proxy-list [data-proxy-name="5.6.7.8-1080"]', { timeout: 5000 });
  }, 30000);

  it("importing the same list again skips duplicates", async () => {
    await h.page.locator('[data-cmd="importProxies"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy-import[open]", { timeout: 5000 });
    const list = "name,type,host,port\nbulk-us,socks5,1.2.3.4,1080";
    await h.page.locator("#dlg-proxy-import-text").fill(list);
    await h.page.evaluate(() => (window as any).agentBrowser.doImportProxies());
    await h.page.waitForTimeout(600);
    const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
    const names = Object.keys(cfg.proxies);
    expect(names.filter((n) => n.startsWith("bulk-us"))).toEqual(["bulk-us"]);
  }, 30000);

  it("exports the proxy store as CSV", async () => {
    const csv: string = await h.page.evaluate(async () => {
      const r = await (window as any).agentBrowser.api.proxy.exportCsv();
      return r && r.success ? r.csv : "";
    });
    expect(csv.split("\n")[0]).toBe("name,type,host,port,username,password");
    expect(csv).toContain("bulk-us,socks5,1.2.3.4,1080,alice,secret");
    expect(csv).toContain("5.6.7.8-1080,socks5h,5.6.7.8,1080,bob,p@ss");
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED|8888|9999/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
