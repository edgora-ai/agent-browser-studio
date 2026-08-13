// J90: In-browser WebRTC diagnostics (RoxyBrowser 3.9.2 "WebRTC logs /
// performance diagnostics" parity). A real RTCPeerConnection probe runs
// inside the profile's own managed Chromium via CDP and reports what ICE
// candidates expose (mDNS vs raw host IPs), connection state and RTT.
// Results persist as a per-profile history and are shown in a dialog.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j90");

describe("J90 — in-browser WebRTC diagnostics", () => {
  let h: TestAppHandle;
  let dirId: string;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, allowProfileVersionSelection: true });
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("creates a profile", async () => {
    const r: any = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.browser.create({ name: "rtc-diag", platform: "windows" }));
    expect(r.dirId).toMatch(/^(ab_|cb_)/);
    dirId = r.dirId;
  }, 20000);

  it("runs an in-browser WebRTC probe and returns a result", async () => {
    const r: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.webrtc.diag(id), dirId);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const res = r.result || {};
    expect(typeof res.rtcAvailable).toBe("boolean");
    expect(Array.isArray(res.candidates)).toBe(true);
    expect(Array.isArray(res.mdnsHosts)).toBe(true);
    expect(Array.isArray(res.hostIps)).toBe(true);
    expect(typeof res.summary).toBe("string");
    expect(res.summary.length).toBeGreaterThan(0);
    expect(typeof res.at).toBe("number");
  }, 45000);

  it("persists a diagnostics history entry", async () => {
    const hist: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.webrtc.diagHistory(id), dirId);
    expect(hist.success).toBe(true);
    expect(hist.entries.length).toBeGreaterThanOrEqual(1);
    const last = hist.entries[hist.entries.length - 1];
    expect(last.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(last.candidates)).toBe(true);
  }, 20000);

  it("shows the WebRTC diagnostics dialog from the profile card", async () => {
    await h.page.evaluate(() => (window as any).agentBrowser.switchTab("profiles"));
    await h.page.waitForTimeout(400);
    const cardSel = `[data-dir-id="${dirId}"]`;
    await h.page.waitForSelector(cardSel + ' [data-action="webrtc-diag"]', { timeout: 8000 });
    await h.page.locator(cardSel + ' [data-action="webrtc-diag"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-webrtc-diag[open]", { timeout: 5000 });
    await h.page.waitForFunction(() => {
      const body = document.getElementById("webrtc-diag-body");
      return !!body && /RTCPeerConnection/.test(body.textContent || "");
    }, { timeout: 45000 });
    const bodyText = await h.page.evaluate(() => (document.getElementById("webrtc-diag-body") as HTMLElement).textContent || "");
    expect(bodyText).toContain("RTCPeerConnection");
    const histText = await h.page.evaluate(() => (document.getElementById("webrtc-diag-history") as HTMLElement).textContent || "");
    expect(histText).toContain("历史记录");
    await h.page.evaluate(() => { (document.getElementById("dlg-webrtc-diag") as HTMLDialogElement).close(); });
  }, 60000);

  it("clears diagnostics history", async () => {
    const r: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.webrtc.diagClear(id), dirId);
    expect(r.success).toBe(true);
    const hist: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.webrtc.diagHistory(id), dirId);
    expect(hist.entries.length).toBe(0);
  }, 20000);

  it("stops the profile browser (cleanup)", async () => {
    const r: any = await h.page.evaluate((id: string) => (window as any).agentBrowser.api.browser.stop(id), dirId);
    expect(r && r.success !== false).toBe(true);
  }, 30000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED|stun/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});

