// Prepared native acceptance only. NOT-RUN by the global UI worker.
// Coordinator must run serially from a newly built isolated actual-input snapshot.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { setupTestApp, type TestAppHandle } from "./helpers/app.js";

const nativeEnabled = process.env.AGENT_BROWSER_GLOBAL_UI_NATIVE_ACCEPTANCE === "1";
describe.skipIf(!nativeEnabled)("global UI serial native acceptance", () => {
  let handle: TestAppHandle;
  let scratch: string;
  let storageEntries: string[][] = [];
  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "global-ui-native-"));
    const cache = path.join(scratch, "empty-controlled-browser-cache"); fs.mkdirSync(cache);
    handle = await setupTestApp({
      userDataDir: path.join(scratch, "user-data"), allowProfileVersionSelection: true,
      env: { AGENT_BROWSER_CHROMIUM_CACHE_DIR: cache },
    });
  }, 60000);
  afterAll(async () => {
    // Graceful close flushes this fixture's Chromium localStorage to disk.
    // Retain scratch for coordinator evidence; never inspect real user storage.
    if (handle) await handle.app.close();
    if (storageEntries.length) {
      // The production BrowserWindow uses UI_STORAGE_PARTITION = persist:app.
      const dir = path.join(handle.userDataDir, "Partitions", "app", "Local Storage", "leveldb");
      const files = fs.readdirSync(dir).filter(name => /\.(?:ldb|log)$/.test(name)).map(name => {
        const bytes = fs.readFileSync(path.join(dir, name));
        return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      });
      expect(files.some(file => file.bytes > 0)).toBe(true);
      fs.writeFileSync(path.join(scratch, "native-storage-evidence.json"), JSON.stringify({
        fixture: "isolated Chromium localStorage, not real user data", storageEntries, databaseDirectory: dir, files,
      }, null, 2));
    }
  }, 30000);

  it("shows the actual app IPC version and current engine state", async () => {
    const version = await handle.page.evaluate(() => (window as any).agentBrowserAPI.app.version());
    expect(typeof version).toBe("string"); expect(version).not.toBe("");
    await handle.page.waitForFunction((v: string) => document.getElementById("sidebar-app-version")?.textContent === "v" + v, version);
    const binary = await handle.page.evaluate(() => (window as any).agentBrowserAPI.browser.binary());
    const label = binary?.installed ? "Chromium " + (binary.version || "?") : "未安装托管 Chromium";
    await handle.page.evaluate(() => (window as any).i18n.set("zh-CN"));
    await handle.page.waitForFunction((text: string) => document.getElementById("sidebar-chrome-status")?.textContent === text, label);
    expect(await handle.page.locator("#sidebar-chrome-status svg").count()).toBe(1);
  });

  it("keeps theme state, one refresh per toggle, and unsaved Agent config through locale change", async () => {
    await handle.page.evaluate(() => {
      const w = window as any;
      if (document.documentElement.getAttribute("data-theme") !== "light") w.agentBrowser.toggleTheme();
      w.i18n.set("en-US");
      const app = w.agentBrowser; const original = app.loadProfiles;
      w.__globalUiLoads = 0; app.loadProfiles = function (...args: any[]) { w.__globalUiLoads++; return original.apply(app, args); };
    });
    await handle.page.locator('[data-cmd="toggleLanguage"]').click();
    expect(await handle.page.evaluate(() => (window as any).__globalUiLoads)).toBe(1);
    expect(await handle.page.locator("#theme-label").textContent()).toBe("浅色");
    expect(await handle.page.locator("#theme-toggle").getAttribute("aria-checked")).toBe("false");
    await handle.page.locator("#nav-agent").click();
    const config = await handle.page.evaluate(async () => {
      const app = (window as any).agentBrowser;
      const saved = await app.api.agent.llmConfig();
      const detected = await app.api.agent.detectLlmConfig();
      app.switchAgentSub("config");
      return { saved, detected };
    });
    // Empty controlled HOME/config means late auto-detect cannot populate fields.
    expect(config.saved).toBeNull(); expect(config.detected).toBeNull();
    // Controlled unsaved input; this test never saves provider config or uses keys.
    await handle.page.locator("#agent-llm-model").fill("unsaved-controlled-model");
    await handle.page.locator('[data-cmd="toggleLanguage"]').click();
    expect(await handle.page.locator("#agent-view-config").isVisible()).toBe(true);
    expect(await handle.page.locator("#agent-llm-model").inputValue()).toBe("unsaved-controlled-model");
    await handle.page.locator("#theme-toggle").press("Space");
    expect(await handle.page.locator("#theme-toggle").getAttribute("aria-checked")).toBe("true");
    expect(await handle.page.locator("#theme-label").textContent()).toBe("Dark");
    await handle.page.reload();
    await handle.page.waitForFunction(() => document.getElementById("theme-label")?.textContent === "Dark");
    expect(await handle.page.evaluate(() => localStorage.getItem("agent-browser-studio-theme"))).toBe("dark");
    // Direct Chromium storage read/search, not merely a setter/API result.
    const cdp = await handle.page.context().newCDPSession(handle.page);
    try {
      await cdp.send("DOMStorage.enable");
      const frame = await cdp.send("Page.getFrameTree");
      const key = await cdp.send("Storage.getStorageKeyForFrame", { frameId: frame.frameTree.frame.id });
      const result = await cdp.send("DOMStorage.getDOMStorageItems", { storageId: { storageKey: key.storageKey, isLocalStorage: true } });
      storageEntries = result.entries.filter(([key]) => key === "agent-browser-studio-theme");
      expect(storageEntries).toEqual([["agent-browser-studio-theme", "dark"]]);
    } finally { await cdp.detach(); }
  });

  it("keeps an ordinary error visible beyond the former TTL and permits dismissal", async () => {
    await handle.page.evaluate(() => (window as any).agentBrowser.helpers.toast("Controlled native acceptance error", "error"));
    await handle.page.waitForTimeout(3300);
    const toast = handle.page.locator(".toast-error").filter({ hasText: "Controlled native acceptance error" });
    expect(await toast.isVisible()).toBe(true); expect(await toast.getAttribute("role")).toBe("alert");
    await toast.locator(".toast-close").click(); expect(await toast.count()).toBe(0);
  });

  it("resolves native dialog name targets in both locales without destroying SVG hosts", async () => {
    const ids = ["dlg-proxy-import", "dlg-proxy-bind", "dlg-webrtc-diag", "dlg-profile-logs", "dlg-skill-market", "dlg-skill-editor", "dlg-automation", "dlg-wizard"];
    for (const locale of ["en-US", "zh-CN"]) {
      await handle.page.evaluate(lang => (window as any).i18n.set(lang), locale);
      for (const id of ids) {
        const result = await handle.page.evaluate(dialogId => {
          const dialog = document.getElementById(dialogId)!;
          const targetId = dialog.getAttribute("aria-labelledby")!;
          const target = document.getElementById(targetId)!;
          return { unique: document.querySelectorAll('[id="' + targetId + '"]').length, contained: dialog.contains(target), text: target?.textContent?.trim(), heading: target?.tagName === "H3" || target?.parentElement?.tagName === "H3" };
        }, id);
        expect(result.unique).toBe(1); expect(result.contained).toBe(true); expect(result.text).toBeTruthy(); expect(result.heading).toBe(true);
      }
      expect(await handle.page.locator("#dlg-wizard-title svg").count()).toBe(1);
      expect(await handle.page.locator("#nav-profiles svg").count()).toBe(1);
    }
    expect(handle.pageErrors).toEqual([]);
  });
});
