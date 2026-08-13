// J71: Window-geometry self-consistency (Slice 46).
// Launches a headed profile with the independent engine and verifies the
// "page tracks the actual window" behavior that upstream CloakBrowser added in
// v0.3.32's unreleased change: window.* geometry (inner/outer width/height,
// screenX/screenY) follows a real resize/move, while the declared screen.*
// display stays fixed — no stale emulated viewport overlay.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import {
  setupTestApp,
  closeApp,
  getAgentBrowserApi,
  TestAppHandle,
} from "./helpers/app.js";
import {
  evaluateInPage,
  waitForCdpPort,
  listTargets,
  connectPageCdp,
  CdpClient,
} from "./helpers/cdp.js";
import { shot, closeAllDialogs, filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j71");

interface Geo {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
  availWidth: number;
  availHeight: number;
  dpr: number;
}

const GEO_EXPR = "(() => { var s = window.screen; return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, screenX: window.screenX, screenY: window.screenY, screenWidth: s.width, screenHeight: s.height, availWidth: s.availWidth, availHeight: s.availHeight, dpr: window.devicePixelRatio }; })()";

describe("J71 — window-geometry self-consistency", () => {
  let h: TestAppHandle;
  let dirId = "";
  let cdpPort = 0;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 90000);

  it("creates and launches a headed profile", async () => {
    const api = await getAgentBrowserApi<any>(h.page);
    const r = await h.page.evaluate(async () => {
      return (window as any).agentBrowser.api.browser.create({
        name: "J71-geometry",
        platform: "windows",
        locale: "en-US",
        timezone: "America/New_York",
        fingerprintSeed: 71171,
      });
    });
    expect(r.dirId).toBeTruthy();
    dirId = r.dirId;
    const lr = (await h.page.evaluate(
      async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
      dirId,
    )) as { success: boolean; cdpPort: number; error?: string };
    expect(lr.success, lr.error || "launch failed").toBe(true);
    cdpPort = lr.cdpPort;
    h.cdpPort = cdpPort;
    h.cdpPids.push(lr.pid);
    await waitForCdpPort(cdpPort, 15000);
    await shot(h.page, "j71-01-launched");
  }, 60000);

  it("initial window geometry is internally self-consistent and fits the declared screen", async () => {
    const g = await evaluateInPage<Geo>(cdpPort, GEO_EXPR);
    expect(g.innerWidth).toBeGreaterThan(0);
    expect(g.innerHeight).toBeGreaterThan(0);
    // Window decorations: inner <= outer.
    expect(g.innerWidth).toBeLessThanOrEqual(g.outerWidth);
    expect(g.innerHeight).toBeLessThanOrEqual(g.outerHeight);
    // The window fits inside the declared fixed display.
    expect(g.outerWidth).toBeLessThanOrEqual(g.screenWidth);
    expect(g.outerHeight).toBeLessThanOrEqual(g.screenHeight);
    // The window is on-screen (allow a small margin for OS title-bar offsets).
    expect(g.screenX + g.outerWidth).toBeLessThanOrEqual(g.availWidth + 40);
    expect(g.screenY + g.outerHeight).toBeLessThanOrEqual(g.availHeight + 120);
    expect(g.dpr).toBeGreaterThan(0);
  }, 20000);

  it("resizing the real window updates window.* but leaves screen.* fixed", async () => {
    const targets = await listTargets(cdpPort);
    const page = targets.find((t) => t.type === "page");
    expect(page, "expected a page target").toBeTruthy();
    const c = await connectPageCdp(cdpPort);
    try {
      const w = await c.send<{ windowId: number }>("Browser.getWindowForTarget", {
        targetId: page!.id,
      });
      expect(w.windowId).toBeGreaterThan(0);
      // Move + resize to a clearly different geometry.
      await c.send("Browser.setWindowBounds", {
        windowId: w.windowId,
        bounds: { left: 60, top: 60, width: 1000, height: 700, windowState: "normal" },
      });
    } finally {
      c.close();
    }
    // Let Chromium apply the new bounds.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const before = await evaluateInPage<Geo>(cdpPort, GEO_EXPR);
    const after = await evaluateInPage<Geo>(cdpPort, GEO_EXPR);
    await shot(h.page, "j71-02-resized");
    // The real window followed the resize.
    expect(after.outerWidth).toBeGreaterThanOrEqual(900);
    expect(after.outerWidth).toBeLessThanOrEqual(1050);
    expect(after.outerHeight).toBeGreaterThanOrEqual(620);
    expect(after.outerHeight).toBeLessThanOrEqual(760);
    // innerWidth tracks the real window too (no fixed emulated viewport).
    expect(after.innerWidth).toBeGreaterThanOrEqual(880);
    expect(after.innerWidth).toBeLessThanOrEqual(after.outerWidth);
    // The declared display stays fixed.
    expect(after.screenWidth).toBe(before.screenWidth);
    expect(after.screenHeight).toBe(before.screenHeight);
    expect(after.availWidth).toBe(before.availWidth);
    // Window geometry is still self-consistent after the move.
    expect(after.innerWidth).toBeLessThanOrEqual(after.outerWidth);
    expect(after.outerWidth).toBeLessThanOrEqual(after.screenWidth);
    expect(after.screenX + after.outerWidth).toBeLessThanOrEqual(after.availWidth + 40);
  }, 25000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
