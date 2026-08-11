// J2: Batch profile management
// bulk-import 3 profiles → Start All → 3 distinct CDP ports + isolated user-data-dirs
// + distinct fingerprints → Stop All → all 3 ports refuse connections
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { setupTestApp, closeApp, TestAppHandle, userDataProfilesDir } from "./helpers/app.js";
import {
  getJsonVersion,
  isPortListening,
  waitForPortClosed,
  waitForCdpPort,
} from "./helpers/cdp.js";
import { shot, closeAllDialogs, filterKnownConsoleErrors } from "./helpers/diag.js";
import { clickCmd, dataTab } from "./helpers/find.js";

const execFile = promisify(execFileCb);
const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j2");

// 3 profiles with distinct platform/locale/seed combinations
const BULK_TEXT = [
  "j2-alpha, windows, en-US, America/New_York, 20001, ",
  "j2-beta, macos, en-US, America/Los_Angeles, 20002, ",
  "j2-gamma, linux, en-US, Europe/London, 20003, ",
].join("\n");

interface LaunchedProfile {
  dirId: string;
  name: string;
  cdpPort: number;
  pid: number;
  platform: string;
  fingerprintSeed: number;
}

describe("J2 — Batch profile create / start-all / stop-all", () => {
  let h: TestAppHandle;
  const launched: LaunchedProfile[] = [];

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  });

  it("bulk-imports 3 distinct profiles", async () => {
    await dataTab(h.page, "profiles").click({ timeout: 5000 });
    await closeAllDialogs(h.page);
    await clickCmd(h.page, "bulkImport");
    await h.page.waitForSelector("#dlg-bulk-import", { state: "visible", timeout: 5000 });
    await h.page.locator("#bulk-import-text").fill(BULK_TEXT);
    await h.page.locator('#dlg-bulk-import button[type="submit"]').click({ timeout: 5000 });
    await h.page.waitForSelector("#dlg-bulk-import", { state: "hidden", timeout: 10000 });
    const profiles = (await h.page.evaluate(
      () => (window as any).agentBrowser.api.browser.list(),
    )) as Array<{ name: string; dirId: string }>;
    const names = profiles.map((p) => p.name);
    expect(names).toContain("j2-alpha");
    expect(names).toContain("j2-beta");
    expect(names).toContain("j2-gamma");
    await shot(h.page, "j2-01-imported");
  });

  it("Start All launches all 3 with distinct ports + isolated user-data-dirs", async () => {
    await clickCmd(h.page, "bulkStart");
    // Poll until all 3 running. Start All is staggered 500ms × 3 + per-profile
    // CDP-ready (up to 15s each, serialized) so allow generous time.
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const list = (await h.page.evaluate(
        () => (window as any).agentBrowser.api.browser.list(),
      )) as Array<any>;
      const running = (list || []).filter((p) => p && p.running);
      if (running.length >= 3) break;
      await h.page.waitForTimeout(500);
    }

    const list = (await h.page.evaluate(
      () => (window as any).agentBrowser.api.browser.list(),
    )) as Array<any>;
    for (const p of list) {
      if (!p || !p.running) continue;
      if (!["j2-alpha", "j2-beta", "j2-gamma"].includes(p.name)) continue;
      launched.push({
        dirId: p.dirId,
        name: p.name,
        cdpPort: p.cdpPort,
        pid: p.pid,
        platform: p.platform,
        fingerprintSeed: p.fingerprintSeed,
      });
      h.cdpPids.push(p.pid);
    }
    expect(launched.length).toBe(3);
    // Wait for all 3 ports to be reachable
    for (const lp of launched) await waitForCdpPort(lp.cdpPort, 15000);

    // 3 distinct ports
    const ports = launched.map((l) => l.cdpPort);
    expect(new Set(ports).size).toBe(3);

    // 3 distinct isolated user-data-dirs
    const profilesDir = userDataProfilesDir(USERDATA);
    const dirsOnDisk = new Set<string>();
    for (const lp of launched) {
      const expected = path.join(profilesDir, lp.dirId);
      expect(fs.existsSync(expected), `missing user-data-dir for ${lp.name}`).toBe(true);
      dirsOnDisk.add(expected);
    }
    expect(dirsOnDisk.size).toBe(3);

    await shot(h.page, "j2-02-all-running");
  });

  it("each profile's /json/version returns a fingerprint-derived UA matching its platform", async () => {
    for (const lp of launched) {
      const v = await getJsonVersion(lp.cdpPort);
      expect(v["User-Agent"], `${lp.name} UA`).toBeTruthy();
      if (lp.platform === "windows") expect(v["User-Agent"]).toContain("Windows NT 10.0");
      else if (lp.platform === "macos") expect(v["User-Agent"]).toMatch(/Mac OS X|Macintosh/);
      else if (lp.platform === "linux") expect(v["User-Agent"]).toMatch(/Linux|X11/);
    }
  });

  it("each launched Chromium was spawned with --fingerprint=<seed> and isolated --user-data-dir", async () => {
    // ps -p <pid> is fragile across detached helper processes; instead grep the
    // full process table for the seed + user-data-dir that this profile should have.
    const all = (await execFile("ps", ["aux"], { maxBuffer: 10 * 1024 * 1024 })).stdout;
    for (const lp of launched) {
      const seedToken = `--fingerprint=${lp.fingerprintSeed}`;
      const dirToken = path.join(USERDATA, "profiles", lp.dirId);
      expect(all, `${lp.name}: missing ${seedToken} in ps aux`).toContain(seedToken);
      expect(all, `${lp.name}: missing ${dirToken} in ps aux`).toContain(dirToken);
    }
  });

  it("Stop All terminates all 3 and ports refuse connections", async () => {
    await clickCmd(h.page, "bulkStop");
    // Poll until none running (Stop All is renderer fan-out, each SIGTERM + 3s SIGKILL fallback)
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const list = (await h.page.evaluate(
        () => (window as any).agentBrowser.api.browser.list(),
      )) as Array<any>;
      const running = list.filter((p) => p && p.running);
      if (running.length === 0) break;
      await h.page.waitForTimeout(500);
    }
    for (const lp of launched) {
      await waitForPortClosed(lp.cdpPort, 8000);
      const listening = await isPortListening(lp.cdpPort);
      expect(listening, `port ${lp.cdpPort} (${lp.name}) should be closed`).toBe(false);
    }
    await shot(h.page, "j2-03-all-stopped");
  });

  it("no unexpected console / page errors during the journey", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors);
    const p = h.pageErrors.filter((e) => !/favicon|punycode/i.test(e));
    if (c.length || p.length) {
      console.log("CONSOLE ERRORS:", c);
      console.log("PAGE ERRORS:", p);
    }
    expect(c, c.join("\n")).toEqual([]);
    expect(p, p.join("\n")).toEqual([]);
  });
});
