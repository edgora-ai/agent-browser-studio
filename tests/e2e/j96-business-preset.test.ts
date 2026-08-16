// J96: Business one-click presets (Slice 75). Proves the preset flow end to end:
//   - the create dialog exposes the preset catalog;
//   - picking a preset prefills a coherent identity (platform / timezone / locale
//     / WebRTC / custom geolocation) plus a description with region, proxy hint
//     and recommended launch gates;
//   - creating from a preset stores the preset id and tags on the profile;
//   - the main process applies the preset authoritatively even when the UI is
//     bypassed, and explicit user fields always win over preset defaults.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j96");

describe("J96 — business one-click presets", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("create dialog exposes the preset catalog", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForTimeout(400);
    await h.page.evaluate(() => (window as any).agentBrowser.newProfile());
    await h.page.waitForSelector("#dlg-profile", { state: "visible", timeout: 5000 });
    await h.page.waitForFunction(() => {
      const sel = document.getElementById("new-profile-preset") as HTMLSelectElement;
      return sel && sel.options.length >= 9; // None + 8 presets
    }, { timeout: 8000 });
    const options = await h.page.locator("#new-profile-preset option").evaluateAll((els: any[]) => els.map((o) => o.value));
    expect(options).toContain("tiktok-shop-us");
    expect(options).toContain("ebay-uk");
    expect(options).toContain("crypto-sg");
  }, 20000);

  it("selecting a preset prefills a coherent identity + description", async () => {
    await h.page.locator("#new-profile-preset").selectOption("tiktok-shop-us", { timeout: 5000 });
    await h.page.waitForFunction(() => {
      const info = document.getElementById("new-profile-preset-info");
      return info && info.style.display !== "none" && info.textContent!.length > 20;
    }, { timeout: 5000 });
    expect(await h.page.locator("#new-agent-browser-platform").inputValue()).toBe("windows");
    expect(await h.page.locator("#new-agent-browser-timezone").inputValue()).toBe("America/Los_Angeles");
    expect(await h.page.locator("#new-agent-browser-locale").inputValue()).toBe("en-US");
    expect(await h.page.locator("#new-agent-browser-webrtc-mode").inputValue()).toBe("auto");
    expect(await h.page.locator("#new-agent-browser-geolocation-latitude").inputValue()).toBe("34.0522");
    expect(await h.page.locator("#new-agent-browser-geolocation-longitude").inputValue()).toBe("-118.2437");
    const info = await h.page.locator("#new-profile-preset-info").textContent();
    expect(info).toMatch(/Region|地区/);
    expect(info).toMatch(/TikTok|tiktok/i);
    // Name auto-suggested from the preset suffix.
    expect(await h.page.locator("#new-profile-name").inputValue()).toBe("TikTok Shop US");
  }, 20000);

  it("creating from a preset stores preset id + tags on the profile", async () => {
    await h.page.locator("#dlg-profile button[type=\"submit\"]").click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-profile", { state: "hidden", timeout: 8000 });
    await h.page.waitForTimeout(1200);
    const profiles: any = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const p = (profiles || []).find((x: any) => x.name === "TikTok Shop US");
    expect(p).toBeTruthy();
    expect(p.preset).toBe("tiktok-shop-us");
    expect(p.tags).toEqual(["tiktok", "ecommerce", "us"]);
    expect(p.timezone).toBe("America/Los_Angeles");
    expect(p.locale).toBe("en-US");
  }, 30000);

  it("main process applies the preset authoritatively when the UI is bypassed", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: "J96-Direct-Ebay", businessPresetId: "ebay-uk",
    }));
    expect(r.dirId).toBeTruthy();
    const profiles: any = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const p = (profiles || []).find((x: any) => x.name === "J96-Direct-Ebay");
    expect(p).toBeTruthy();
    expect(p.preset).toBe("ebay-uk");
    expect(p.platform).toBe("windows");
    expect(p.timezone).toBe("Europe/London");
    expect(p.locale).toBe("en-GB");
    expect(p.geolocationMode).toBe("custom");
    expect(p.geolocationLatitude).toBeCloseTo(51.5074, 3);
    expect(p.tags).toEqual(["ebay", "ecommerce", "uk"]);
  }, 30000);

  it("explicit user fields win over preset defaults", async () => {
    const r = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: "J96-Override", businessPresetId: "crypto-sg", locale: "en-US",
    }));
    expect(r.dirId).toBeTruthy();
    const profiles: any = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    const p = (profiles || []).find((x: any) => x.name === "J96-Override");
    expect(p).toBeTruthy();
    // Explicit locale wins; preset still supplies the rest coherently.
    expect(p.locale).toBe("en-US");
    expect(p.timezone).toBe("Asia/Singapore");
    expect(p.geolocationMode).toBe("custom");
    expect(p.preset).toBe("crypto-sg");
  }, 30000);

  it("no unexpected console errors", () => {
    const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(errs.length, errs.join("\n")).toBe(0);
  });
});
