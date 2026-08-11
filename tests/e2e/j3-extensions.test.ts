// J3: Chrome extension repository → load → enable
// add by Web Store ID → enable for profile → launch → verify --load-extension arg + unpacked path
//
// Network-gated: Chrome Web Store download needs internet.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  setupTestApp,
  closeApp,
  configureDefaultProxy,
  TestAppHandle,
  userDataExtensionRepoDir,
} from "./helpers/app.js";
import { waitForCdpPort, waitForPortClosed } from "./helpers/cdp.js";
import { shot, closeAllDialogs, filterKnownConsoleErrors } from "./helpers/diag.js";
import { dataTab, clickCmd } from "./helpers/find.js";

const execFile = promisify(execFileCb);
const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j3");

// uBlock Origin Lite — small, stable, well-known extension on the Chrome Web Store.
const EXT_ID = "cjpalhdlnbpafiamejdnhcphjbkeijoj";

// Enable J3 when EITHER:
//  - E2E_EXTENSION_NETWORK=1 → host can reach clients2.google.com directly, OR
//  - E2E_TEST_PROXY=<url>    → host can't, but a proxy at <url> can. The app's
//                              default proxy is configured via IPC so the CRX
//                              download routes through it (the product path).
const EXT_NETWORK_ENABLED = ["1", "true", "yes"].includes(
  (process.env.E2E_EXTENSION_NETWORK || "").toLowerCase(),
);
const TEST_PROXY = process.env.E2E_TEST_PROXY || "";
const J3_ENABLED = EXT_NETWORK_ENABLED || TEST_PROXY.length > 0;
describe.skipIf(!J3_ENABLED)(
  "J3 — Chrome extension repository add → enable → launch",
  () => {
    let h: TestAppHandle;
    let dirId = "";
    let cdpPort = 0;
    let pid = 0;

    beforeAll(async () => {
      h = await setupTestApp({ userDataDir: USERDATA });
      // If the host can't reach Google directly, route the CRX download through
      // the test proxy via the app's default-proxy setting (real product path).
      if (TEST_PROXY) {
        await configureDefaultProxy(h.page, TEST_PROXY);
      }
    }, 60000);

    afterAll(async () => {
      if (h) {
        try {
          if (dirId) {
            await h.page
              .evaluate(
                async (id: string) => (window as any).agentBrowser.api.browser.stop(id),
                dirId,
              )
              .catch(() => undefined);
            await h.page
              .evaluate(
                (id: string) => (window as any).agentBrowser.api.settings.deleteRepositoryExtension(id),
                EXT_ID,
              )
              .catch(() => undefined);
          }
        } catch (_) {
          /* ignore */
        }
        await closeApp(h);
      }
    });

    it("creates a profile to host the extension", async () => {
      const r = (await h.page.evaluate(
        () =>
          (window as any).agentBrowser.api.browser.create({
            name: "E2E J3",
            platform: "windows",
            fingerprintSeed: 33333,
          }),
      )) as { dirId: string };
      expect(r.dirId).toBeTruthy();
      dirId = r.dirId;
    });

    it("adds the extension to the private repository", async () => {
      const r = (await h.page.evaluate(
        (id: string) =>
          (window as any).agentBrowser.api.settings.addRepositoryExtension(id, {
            source: "chrome-store",
          }),
        EXT_ID,
      )) as { success: boolean; error?: string; extId?: string };
      expect(r.success, JSON.stringify(r)).toBe(true);
      await shot(h.page, "j3-01-added");
    });

    it("repository entry materializes on disk with a manifest.json", async () => {
      const repoDir = userDataExtensionRepoDir(USERDATA);
      // The repository stores unpacked content under <extId>/current
      const start = Date.now();
      let manifestPath = "";
      while (Date.now() - start < 60000) {
        // Try the standard layout
        const candidate = path.join(repoDir, EXT_ID, "current", "manifest.json");
        if (fs.existsSync(candidate)) {
          manifestPath = candidate;
          break;
        }
        // Fallback: search for any manifest.json under <extId>/
        const base = path.join(repoDir, EXT_ID);
        if (fs.existsSync(base)) {
          try {
            for (const entry of fs.readdirSync(base, { withFileTypes: true, recursive: false } as any)) {
              const m = path.join(base, entry.name, "manifest.json");
              if (fs.existsSync(m)) {
                manifestPath = m;
                break;
              }
            }
          } catch (_) {
            /* ignore */
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(manifestPath, "manifest.json not found for extension").not.toBe("");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.manifest_version || manifest.manifestVersion).toBeTruthy();
    });

    it("enables the extension for the profile", async () => {
      const r = (await h.page.evaluate(
        (args: { id: string; ext: string }) =>
          (window as any).agentBrowser.api.settings.toggleExtension(args.id, args.ext, true),
        { id: dirId, ext: EXT_ID },
      )) as { success: boolean; error?: string };
      expect(r.success, JSON.stringify(r)).toBe(true);
    });

    it("launches the profile and the Chromium carries --load-extension pointing at the repo path", async () => {
      const r = (await h.page.evaluate(
        (id: string) => (window as any).agentBrowser.api.browser.launch(id),
        dirId,
      )) as { success: boolean; cdpPort: number; pid: number };
      expect(r.success).toBe(true);
      cdpPort = r.cdpPort;
      pid = r.pid;
      h.cdpPort = cdpPort;
      h.cdpPids.push(pid);
      await waitForCdpPort(cdpPort, 15000);

      const all = (await execFile("ps", ["aux"], { maxBuffer: 10 * 1024 * 1024 })).stdout;
      expect(all, "no --load-extension in any process").toContain("--load-extension=");
      expect(all, "no --disable-extensions-except in any process").toContain(
        "--disable-extensions-except=",
      );
      // The load-extension path must reference the repository directory for this extension
      expect(all).toContain(EXT_ID);
      await shot(h.page, "j3-02-launched");
    });

    it("stops the profile and the port closes", async () => {
      await h.page.evaluate(
        (id: string) => (window as any).agentBrowser.api.browser.stop(id),
        dirId,
      );
      await waitForPortClosed(cdpPort, 10000);
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
  },
);
