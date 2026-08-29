// J103: crash nets actually work (I7 acceptance E2). An unhandled promise
// rejection raised INSIDE the main process must be logged through
// observability (app.unhandled-rejection) and must not take the app down —
// the renderer stays responsive and IPC keeps working afterwards.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j103");

describe("J103 — main-process crash nets (I7/E2)", () => {
  let h: TestAppHandle;
  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);
  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("logs an unhandled rejection and keeps the app alive", async () => {
    // Fire the rejection inside the MAIN process (not the renderer).
    await h.app.evaluate(() => {
      void Promise.reject(new Error("j103-crash-net-probe"));
    });
    await h.page.waitForTimeout(500);

    const events = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const res = await api.observability.events(200, { event: "app.unhandled-rejection" });
      return res.events || [];
    });
    const probe = JSON.stringify(events);
    expect(events.length, "unhandled-rejection should be logged: " + probe.slice(0, 200)).toBeGreaterThan(0);
    expect(probe).toContain("j103-crash-net-probe");

    // The app must still be alive and responsive after swallowing the rejection.
    expect(h.page.isClosed()).toBe(false);
    const alive = await h.page.evaluate(async () => {
      const api = (window as any).agentBrowser.api;
      const list = await api.browser.list();
      return { ok: 1 + 1, profiles: Array.isArray(list) ? list.length : -1 };
    });
    expect(alive.ok).toBe(2);
    expect(alive.profiles).toBeGreaterThanOrEqual(0);
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
