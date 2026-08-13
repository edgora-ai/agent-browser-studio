// J89: Proxy quick-bind profiles + QR export (RoxyBrowser 3.9.1 parity).
// The proxy list cards gain "📎 Bind" (link the proxy to selected profiles
// in one click) and "📱 QR" (export the full proxy config as a scannable
// QR code). Backend binding already existed; this slice adds the one-click
// UI plus a main-process proxy:qrcode IPC that returns a data:image/png URL.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j89");
const proxyCard = '#proxy-list [data-proxy-name="bind-qr-proxy"]';

describe("J89 — proxy quick-bind profiles + QR export", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, allowProfileVersionSelection: true });
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

 it("seeds two profiles and one authenticated proxy", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({ name: "bind-a", platform: "windows" }));
    await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({ name: "bind-b", platform: "windows" }));
    const added: any = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.proxy.add("bind-qr-proxy", {
        type: "socks5", host: "127.0.0.1", port: 7890, username: "demo", password: "s3cret",
      }));
    expect(added.success).toBe(true);
    const proxies: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.list());
    expect(proxies.some((p: any) => p.name === "bind-qr-proxy")).toBe(true);
  }, 30000);

  it("renders Bind + QR actions on the proxy card", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("proxy"));
    await h.page.waitForSelector(proxyCard, { timeout: 8000 });
    await h.page.waitForSelector(proxyCard + ' [data-action="bind-profiles"]', { timeout: 5000 });
    await h.page.waitForSelector(proxyCard + ' [data-action="qrcode-proxy"]', { timeout: 5000 });
    expect(true).toBe(true);
  }, 20000);

  it("one-click bind links the proxy to the selected profiles", async () => {
    await h.page.locator(proxyCard + ' [data-action="bind-profiles"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy-bind[open]", { timeout: 5000 });
    const rows = await h.page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("#dlg-proxy-bind-list .proxy-bind-item"));
      return items.map((el) => el.textContent || "");
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Select every profile and confirm. The dialog lists names only when a
    // profile is unbound; bound ones show their current proxy.
    await h.page.evaluate(() => {
      Array.from(document.querySelectorAll("#dlg-proxy-bind-list input[type=checkbox]"))
        .forEach((b) => { (b as HTMLInputElement).checked = true; });
    });
    await h.page.evaluate(() => (window as any).agentBrowser.doBindProxyToProfiles());
    await h.page.waitForFunction(() => !(document.getElementById("dlg-proxy-bind") as HTMLDialogElement)?.open, { timeout: 5000 });
    const profiles: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const bound = profiles.filter((p: any) => p.proxyName === "bind-qr-proxy");
    expect(bound.map((p: any) => p.name).sort()).toEqual(["bind-a", "bind-b"]);
    expect(bound.every((p: any) => p.proxyMode === "named")).toBe(true);
  }, 30000);

  it("QR export renders a data:image/png QR code with the proxy URI", async () => {
    await h.page.locator(proxyCard + ' [data-action="qrcode-proxy"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-proxy-qr[open]", { timeout: 5000 });
    await h.page.waitForFunction(() => {
      const img = document.getElementById("dlg-proxy-qr-img") as HTMLImageElement | null;
      return !!img && img.src.startsWith("data:image/png;base64,");
    }, { timeout: 8000 });
    const src = await h.page.evaluate(() => (document.getElementById("dlg-proxy-qr-img") as HTMLImageElement).src);
    expect(src.startsWith("data:image/png;base64,")).toBe(true);
    const uri = await h.page.evaluate(() => (document.getElementById("dlg-proxy-qr-uri") as HTMLElement).textContent);
    expect(uri).toContain("socks5://demo:");
    expect(uri).toContain("@127.0.0.1:7890");
    await h.page.evaluate(() => { (document.getElementById("dlg-proxy-qr") as HTMLDialogElement).close(); });
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
