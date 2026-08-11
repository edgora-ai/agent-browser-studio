// Capture README screenshots with a pre-seeded app. Normal full-suite runs use
// a temporary output directory so they cannot overwrite uncommitted docs.
// To update docs explicitly:
// UPDATE_README_SCREENSHOTS=1 npx vitest run -c vitest.config.e2e.ts tests/e2e/j-screenshots.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { closeAllDialogs } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j-screenshots");
const UPDATE_README_SCREENSHOTS = process.env.UPDATE_README_SCREENSHOTS === "1";
const OUT = UPDATE_README_SCREENSHOTS
  ? path.join(REPO, "docs", "screenshots")
  : path.join(os.tmpdir(), `cloak-readme-screenshots-${process.pid}`);

describe("J-screenshots — README captures", () => {
  let h: TestAppHandle;

  beforeAll(async () => {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    // Wipe and pre-seed config BEFORE launching the app so the in-memory
    // config is initialized from our fixtures on first load.
    fs.rmSync(USERDATA, { recursive: true, force: true });
    fs.mkdirSync(USERDATA, { recursive: true });
    const cfg = {
      version: 3,
      cloakBin: "auto",
      defaultProxy: "default",
      proxies: {
        default: { type: "http", host: "127.0.0.1", port: 7890 },
        hk01: { type: "http", host: "proxy.example.com", port: 8080, username: "alice", password: "encrypted:redacted" },
      },
      proxyDetections: {},
      sync: { enabled: false },
      cloakProfiles: {
        cb_amazon_us: {
          dirId: "cb_amazon_us", name: "Amazon US Shop", version: "149", fingerprintSeed: 12345,
          platform: "windows", timezone: "America/Los_Angeles", locale: "en-US", webrtcIp: "203.0.113.10",
          proxyMode: "named", proxyName: "hk01", tags: ["amazon", "us"],
          syncedAt: null, syncStatus: "never", lastModified: Date.now(),
        },
        cb_qa_local: {
          dirId: "cb_qa_local", name: "QA Local", version: "149", fingerprintSeed: 67890,
          platform: "macos", timezone: "Asia/Shanghai", locale: "zh-CN", webrtcIp: "198.51.100.5",
          proxyMode: "default", tags: ["qa"],
          syncedAt: null, syncStatus: "never", lastModified: Date.now(),
        },
      },
      agent: { provider: "openai", apiKey: "encrypted:test", model: "gpt-4o-mini", apiUrl: "https://api.openai.com/v1/chat/completions" },
      automation: [],
      agentRuns: [],
    };
    fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
    h = await setupTestApp({ userDataDir: USERDATA, resetUserData: false });
    await h.page.evaluate(() => {
      try { (window as any).i18n?.set("en-US"); (window as any).i18n?.apply(); } catch (e) {}
      document.documentElement.setAttribute("data-theme", "light");
    });
    await h.page.waitForTimeout(500);
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (!UPDATE_README_SCREENSHOTS) fs.rmSync(OUT, { recursive: true, force: true });
  });

  async function shot(tab: string, file: string) {
    await h.page.evaluate((t) => (window as any).cloak.switchTab(t), tab);
    await h.page.waitForTimeout(900);
    await h.page.screenshot({ path: path.join(OUT, file), fullPage: false });
    expect(fs.existsSync(path.join(OUT, file))).toBe(true);
  }

  it("captures each major tab", async () => {
    await closeAllDialogs(h.page);
    await shot("profiles", "profiles.png");
    await shot("proxy", "proxy.png");
    await shot("agent", "agent-chat.png");
    await shot("automation", "automation.png");
    await shot("sync", "sync.png");
    await shot("activity", "activity.png");
    await shot("runs", "runs.png");
    await shot("extensions", "extensions.png");
  });

  it("captures the wizard overlay", async () => {
    await h.page.evaluate(() => { (window as any).wizardDismissed = false; (window as any).cloak.showWizard(); });
    await h.page.waitForTimeout(800);
    await h.page.screenshot({ path: path.join(OUT, "wizard.png"), fullPage: false });
    expect(fs.existsSync(path.join(OUT, "wizard.png"))).toBe(true);
  });
});
