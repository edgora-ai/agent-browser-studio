// J81: UI storage partition + legacy migration (Slice 58 — cold-start fix).
//
// The main window used to run on Electron's default session, whose storage
// service does a discovery pass over the whole user-data tree on first access.
// With managed browser profiles running inside <userData>/profiles, that pass
// blocked on their LevelDB locks and DOMContentLoaded stalled ~4s. The window
// now uses its own persist:app partition (Partitions/app) and the few legacy
// renderer settings (theme / language / wizard state) are copied over once.
//
// This journey guards three things:
//   1. the window really writes to the partition, not the default session;
//   2. legacy settings survive the migration;
//   3. first paint stays fast even with a busy user-data tree.
import { describe, it, expect, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupTestApp, closeApp, type TestAppHandle } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const execFileP = promisify(execFile);
const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j81");
const ELECTRON_BIN = path.join(
  REPO,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);
const SEED_MAIN = path.join(REPO, "tests", "e2e", "helpers", "seed-legacy-storage.mjs");

function partitionLevelDb(userDataDir: string): string {
  return path.join(userDataDir, "Partitions", "app", "Local Storage", "leveldb");
}

function defaultLevelDb(userDataDir: string): string {
  return path.join(userDataDir, "Local Storage", "leveldb");
}

function migrationMarker(userDataDir: string): string {
  return path.join(userDataDir, ".ui-storage-migrated-v1");
}

async function seedLegacyStorage(userDataDir: string): Promise<void> {
  await execFileP(ELECTRON_BIN, [SEED_MAIN, "--user-data-dir=" + userDataDir], { timeout: 30000 });
}

function buildBusyUserDataTree(userDataDir: string): void {
  // A fake "running" managed profile: a recognizable Chromium storage layout so
  // the tree looks like the real post-crash / mid-run state that used to stall
  // the default session's storage discovery.
  const fakeProfile = path.join(userDataDir, "profiles", "fake-running", "Local Storage", "leveldb");
  fs.mkdirSync(fakeProfile, { recursive: true });
  fs.writeFileSync(path.join(fakeProfile, "LOCK"), "");
  fs.writeFileSync(path.join(fakeProfile, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(fakeProfile, "MANIFEST-000001"), "manifest");
  fs.writeFileSync(path.join(fakeProfile, "000003.log"), "log");
}

describe("J81 — UI storage partition + legacy migration (Slice 58)", () => {
  let h: TestAppHandle | null = null;

  async function launch(userDataDir: string, reset: boolean): Promise<TestAppHandle> {
    if (h) {
      await closeApp(h);
      h = null;
    }
    h = await setupTestApp({ userDataDir, resetUserData: reset });
    return h;
  }

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 90000);

  it("writes UI storage to its own partition and leaves the default session alone", async () => {
    const handle = await launch(USERDATA, true);
    const theme = await handle.page.evaluate(() => localStorage.getItem("agent-browser-studio-theme"));
    expect(theme).toBeTruthy();
    const partitionEntries = fs.readdirSync(partitionLevelDb(handle.userDataDir));
    expect(partitionEntries.some((e) => e !== "LOCK")).toBe(true);
    expect(fs.existsSync(defaultLevelDb(handle.userDataDir))).toBe(false);
    expect(fs.existsSync(migrationMarker(handle.userDataDir))).toBe(true);
  }, 60000);

  it("keeps first paint fast even with a busy user-data tree", async () => {
    const busy = path.join(USERDATA, "..", "j81-busy");
    fs.rmSync(busy, { recursive: true, force: true });
    fs.mkdirSync(busy, { recursive: true });
    buildBusyUserDataTree(busy);
    const handle = await launch(busy, false);
    const nav = await handle.page.evaluate(() => {
      const nt = performance.getEntriesByType("navigation")[0] as any;
      return { dcl: Math.round(nt.domContentLoadedEventEnd), load: Math.round(nt.loadEventEnd) };
    });
    console.log("J81 busy-tree DCL=" + nav.dcl + "ms load=" + nav.load + "ms");
    expect(nav.dcl).toBeLessThan(2000);
    expect(fs.existsSync(partitionLevelDb(handle.userDataDir))).toBe(true);
  }, 60000);

  it("migrates legacy theme/language/wizard settings into the partition", async () => {
    const legacy = path.join(USERDATA, "..", "j81-legacy");
    fs.rmSync(legacy, { recursive: true, force: true });
    fs.mkdirSync(legacy, { recursive: true });
    await seedLegacyStorage(legacy);
    const handle = await launch(legacy, false);

    const stored = await handle.page.evaluate(() => ({
      theme: localStorage.getItem("agent-browser-studio-theme"),
      legacyTheme: localStorage.getItem("cloak-theme"),
      lang: localStorage.getItem("agent-browser-studio-language"),
      legacyLang: localStorage.getItem("cloak-lite-language"),
      wizard: localStorage.getItem("agent-browser-studio-wizard-dismissed"),
      htmlTheme: document.documentElement.getAttribute("data-theme"),
    }));
    expect(stored.theme).toBe("dark");
    expect(stored.legacyTheme).toBe("dark");
    expect(stored.lang).toBe("zh-CN");
    expect(stored.legacyLang).toBe("zh-CN");
    expect(stored.wizard).toBe("1");
    expect(stored.htmlTheme).toBe("dark");
    expect(fs.existsSync(migrationMarker(handle.userDataDir))).toBe(true);
  }, 60000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h?.consoleErrors ?? []).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
