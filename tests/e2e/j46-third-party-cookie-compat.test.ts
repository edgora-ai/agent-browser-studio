// J46: opt-in third-party-cookie compatibility uses Chromium's stock profile
// preferences, permits a real cross-site iframe cookie, and restores the
// profile's prior blocking preference when disabled.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { connectPageCdp, waitForCdpPort, waitForPortClosed } from "./helpers/cdp.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j46");

interface CookieProbe { documentCookie: string; requestCookie: string }
interface CookiePreferences {
  cookieControlsMode: unknown;
  trackingProtection3pcdEnabled: unknown;
  blockAll3pcToggleEnabled: unknown;
}

describe("J46 — third-party-cookie compatibility", () => {
  let h: TestAppHandle;
  let server: http.Server;
  let topUrl = "";
  let dirId = "";
  const serverRequests: string[] = [];
  let originalPreferences: CookiePreferences | null = null;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      serverRequests.push(`${request.headers.host || ""}${url.pathname}`);
      response.setHeader("cache-control", "no-store");
      if (url.pathname === "/echo") {
        response.setHeader("content-type", "text/plain");
        response.end(request.headers.cookie || "");
        return;
      }
      if (url.pathname === "/frame") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta charset="utf-8"><script>
          document.cookie = "roxy3pc=enabled; Path=/; SameSite=None; Secure";
          fetch("/echo?" + Date.now(), {credentials:"include", cache:"no-store"})
            .then(function(response){ return response.text(); })
            .then(function(requestCookie){ parent.postMessage({documentCookie:document.cookie, requestCookie:requestCookie}, "*"); })
            .catch(function(error){ parent.postMessage({documentCookie:document.cookie, requestCookie:"error:"+error.message}, "*"); });
        <\/script>`);
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      response.end(`<!doctype html><meta charset="utf-8"><script>
        window.__cookieResult = null;
        addEventListener("message", function(event){ window.__cookieResult = event.data; });
      <\/script><iframe src="http://[::1]:${port}/frame?${Date.now()}"></iframe>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: 0, host: "::", ipv6Only: false }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("J46 HTTPS server did not bind");
    topUrl = `http://127.0.0.1:${address.port}/top`;

    h = await setupTestApp({ userDataDir: USERDATA });
    const created = await h.page.evaluate(async () => (window as any).cloak.api.cloak.create({
      name: "J46 cookies",
      platform: "windows",
      fingerprintSeed: 46464,
      proxyMode: "none",
      allowThirdPartyCookies: false,
    }));
    dirId = created.dirId;
    const prefsPath = path.join(USERDATA, "cloak-profiles", dirId, "Default", "Preferences");
    fs.writeFileSync(prefsPath, JSON.stringify({
      profile: { cookie_controls_mode: 1 },
      tracking_protection: {
        tracking_protection_3pcd_enabled: true,
        block_all_3pc_toggle_enabled: true,
      },
    }));
  }, 60_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 90_000);

  async function launchAndProbe(): Promise<CookieProbe> {
    const requestStart = serverRequests.length;
    const launched = await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.launch(id), dirId) as {
      success: boolean; pid: number; cdpPort: number; error?: string;
    };
    expect(launched.success, launched.error || "J46 launch failed").toBe(true);
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(launched.cdpPort, 15_000);
    const client = await connectPageCdp(launched.cdpPort);
    let result: CookieProbe | null = null;
    let lastProbe: { href?: string; frameCount?: number; result?: CookieProbe | null } | null = null;
    try {
      await client.send("Page.enable");
      const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: `${topUrl}?${Date.now()}` });
      if (navigation.errorText) throw new Error(`J46 navigation failed: ${navigation.errorText}`);
      const started = Date.now();
      while (Date.now() - started < 15_000) {
        lastProbe = await client.send<{ result: { value: { href: string; frameCount: number; result: CookieProbe | null } } }>("Runtime.evaluate", {
          expression: "({href:location.href,frameCount:frames.length,result:window.__cookieResult||null})",
          returnByValue: true,
          awaitPromise: true,
        }).then((response) => response.result.value).catch(() => null);
        result = lastProbe?.result || null;
        if (result) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } finally {
      client.close();
      await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.stop(id), dirId);
      await waitForPortClosed(launched.cdpPort, 10_000);
      const stoppedAt = Date.now();
      while (Date.now() - stoppedAt < 10_000) {
        const status = await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.status(id), dirId);
        if (!status.running) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!result) throw new Error(`third-party cookie iframe did not report a result: ${JSON.stringify({ lastProbe, requests: serverRequests.slice(requestStart) })}`);
    return result;
  }

  it("blocks the iframe cookie under the profile's original setting", async () => {
    const result = await launchAndProbe();
    expect(result.documentCookie).not.toContain("roxy3pc=enabled");
    expect(result.requestCookie).not.toContain("roxy3pc=enabled");
    const prefs = JSON.parse(fs.readFileSync(path.join(USERDATA, "cloak-profiles", dirId, "Default", "Preferences"), "utf-8"));
    originalPreferences = {
      cookieControlsMode: prefs.profile.cookie_controls_mode,
      trackingProtection3pcdEnabled: prefs.tracking_protection.tracking_protection_3pcd_enabled,
      blockAll3pcToggleEnabled: prefs.tracking_protection.block_all_3pc_toggle_enabled,
    };
  }, 45_000);

  it("allows the real iframe cookie only after explicit compatibility opt-in", async () => {
    const saved = await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.setMeta(id, { allowThirdPartyCookies: true }), dirId);
    expect(saved.success).toBe(true);
    const result = await launchAndProbe();
    expect(result.documentCookie).toContain("roxy3pc=enabled");
    expect(result.requestCookie).toContain("roxy3pc=enabled");
  }, 45_000);

  it("restores the exact blocking preference when compatibility is disabled", async () => {
    const saved = await h.page.evaluate(async (id: string) => (window as any).cloak.api.cloak.setMeta(id, { allowThirdPartyCookies: false }), dirId);
    expect(saved.success).toBe(true);
    const result = await launchAndProbe();
    expect(result.documentCookie).not.toContain("roxy3pc=enabled");
    expect(result.requestCookie).not.toContain("roxy3pc=enabled");
    const prefs = JSON.parse(fs.readFileSync(path.join(USERDATA, "cloak-profiles", dirId, "Default", "Preferences"), "utf-8"));
    expect(originalPreferences).not.toBeNull();
    expect({
      cookieControlsMode: prefs.profile.cookie_controls_mode,
      trackingProtection3pcdEnabled: prefs.tracking_protection.tracking_protection_3pcd_enabled,
      blockAll3pcToggleEnabled: prefs.tracking_protection.block_all_3pc_toggle_enabled,
    }).toEqual(originalPreferences);
    expect(fs.existsSync(path.join(USERDATA, "cloak-profiles", dirId, ".roxy-third-party-cookie-backup.json"))).toBe(false);
  }, 45_000);
});
