// App helper — launch the real Electron app via Playwright with isolated userData.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { _electron as electron, ElectronApplication, Page } from "playwright";
import { closeAllDialogs } from "./diag.js";

const execFileP = promisify(execFile);

// Locate the independently built Chromium cache without consulting a wrapper
// cache or network service.
function resolveManagedChromiumPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicitPath = env.AGENT_BROWSER_CHROMIUM_BINARY_PATH || env.CLOAKLITE_CHROMIUM_BINARY_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  const home = os.homedir();
  const currentCached = newestCachedBinary(path.join(home, ".agent-browser-studio"));
  if (currentCached) return currentCached;
  if (process.platform === "darwin") {
    const developmentBinary = path.resolve(
      REPO, "..", "chromium-build-150", "src", "out",
      "Chromium.app", "Contents", "MacOS", "Chromium",
    );
    if (fs.existsSync(developmentBinary)) return developmentBinary;
  }
  return newestCachedBinary(path.join(home, ".roxy-lite-cloak"));
}

function resolveManagedChromiumCacheRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicitRoot = env.AGENT_BROWSER_CHROMIUM_CACHE_DIR || env.CLOAKLITE_CHROMIUM_CACHE_DIR;
  if (explicitRoot) return path.resolve(explicitRoot);
  const home = os.homedir();
  const currentRoot = path.join(home, ".agent-browser-studio");
  if (newestCachedBinary(currentRoot)) return currentRoot;
  const legacyRoot = path.join(home, ".roxy-lite-cloak");
  return newestCachedBinary(legacyRoot) ? legacyRoot : null;
}

function newestCachedBinary(cacheDir: string): string | null {
  if (!fs.existsSync(cacheDir)) return null;
  const candidates: Array<{ version: number[]; path: string }> = [];
  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      const match = entry.match(/^chromium-(\d+(?:\.\d+){3})(?:\..*)?$/);
      if (!match) continue;
      const cand =
        process.platform === "win32"
          ? path.join(cacheDir, entry, "chrome.exe")
          : process.platform === "darwin"
            ? path.join(cacheDir, entry, "Chromium.app", "Contents", "MacOS", "Chromium")
            : path.join(cacheDir, entry, "chromium");
      if (fs.existsSync(cand)) candidates.push({ version: match[1].split(".").map(Number), path: cand });
    }
  } catch (_) {
    /* ignore */
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const delta = (b.version[i] || 0) - (a.version[i] || 0);
      if (delta) return delta;
    }
    return 0;
  });
  return candidates[0]?.path || null;
}

const REPO = path.resolve(__dirname, "..", "..", "..");
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

export interface SetupTestAppOptions {
  userDataDir: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  timeoutMs?: number;
  /** Wipe userDataDir before launch. Default true. Set false when relaunching to
   *  preserve state (e.g. persistence tests). */
  resetUserData?: boolean;
  /** Do not force the newest binary through the environment; allows profile pins. */
  allowProfileVersionSelection?: boolean;
}

export interface TestAppHandle {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  consoleErrors: string[];
  pageErrors: string[];
  cdpPort: number | null;
  cdpPids: number[];
}

export async function setupTestApp(opts: SetupTestAppOptions): Promise<TestAppHandle> {
  if (opts.resetUserData !== false) {
    fs.rmSync(opts.userDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(opts.userDataDir, { recursive: true });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const cdpPids: number[] = [];

  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    ...opts.env,
  };
  const chromiumBin = resolveManagedChromiumPath(launchEnv);
  if (opts.allowProfileVersionSelection) {
    const cacheRoot = resolveManagedChromiumCacheRoot(launchEnv);
    if (cacheRoot && !launchEnv.AGENT_BROWSER_CHROMIUM_CACHE_DIR && !launchEnv.CLOAKLITE_CHROMIUM_CACHE_DIR) {
      launchEnv.AGENT_BROWSER_CHROMIUM_CACHE_DIR = cacheRoot;
    }
  } else if (chromiumBin) {
    launchEnv.AGENT_BROWSER_CHROMIUM_BINARY_PATH = chromiumBin;
  }

  const app = await electron.launch({
    args: [REPO, `--user-data-dir=${opts.userDataDir}`, ...(opts.args ?? [])],
    executablePath: ELECTRON_BIN,
    env: launchEnv,
    timeout: opts.timeoutMs ?? 30000,
  });
  if (process.env.AGENT_BROWSER_E2E_TRACE === "1" || process.env.CLOAK_E2E_TRACE === "1") {
    app.process().stdout?.on("data", (chunk) => process.stdout.write(`[electron:stdout] ${chunk}`));
    app.process().stderr?.on("data", (chunk) => process.stderr.write(`[electron:stderr] ${chunk}`));
  }

  const page = await app.firstWindow({ timeout: 20000 });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.waitForFunction(
    () => (window as any).agentBrowser && (window as any).agentBrowser.switchTab,
    { timeout: 20000 },
  );
  await page.waitForSelector("#tab-profiles", { timeout: 15000 });
  await page.waitForTimeout(500);
  await dismissWizard(page);

  return {
    app,
    page,
    userDataDir: opts.userDataDir,
    consoleErrors,
    pageErrors,
    cdpPort: null,
    cdpPids,
  };
}

export interface HeadlessAppHandle {
  app: ElectronApplication;
  port: number;
  token: string;
  userDataDir: string;
  close: () => Promise<void>;
}

/** Pick a currently free loopback port (race-safe enough for tests). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function healthOk(port: number, token: string, deadline: number): Promise<{ ok: boolean; body: any }> {
  return new Promise((resolve) => {
    const done = (v: any) => resolve(v);
    const attempt = () => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/health", method: "GET", headers: { authorization: "Bearer " + token } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: any = null;
            try { body = JSON.parse(text); } catch { body = text; }
            if (res.statusCode === 200 && body && body.status === "ok") return done({ ok: true, body });
            if (Date.now() > deadline) return done({ ok: false, body });
            setTimeout(attempt, 300);
          });
        },
      );
      req.on("error", () => {
        if (Date.now() > deadline) return done({ ok: false, body: null });
        setTimeout(attempt, 300);
      });
      req.end();
    };
    attempt();
  });
}

/** Launch the controller in --headless server mode and wait for /health. */
export async function launchHeadlessApp(opts: {
  userDataDir: string;
  token?: string;
  timeoutMs?: number;
}): Promise<HeadlessAppHandle> {
  fs.rmSync(opts.userDataDir, { recursive: true, force: true });
  fs.mkdirSync(opts.userDataDir, { recursive: true });
  const token = opts.token || "test-headless-token";
  const port = await freePort();
  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    AGENT_BROWSER_API_PORT: String(port),
    AGENT_BROWSER_API_TOKEN: token,
  };
  const chromiumBin = resolveManagedChromiumPath(launchEnv);
  if (chromiumBin) launchEnv.AGENT_BROWSER_CHROMIUM_BINARY_PATH = chromiumBin;

  const app = await electron.launch({
    args: [REPO, "--user-data-dir=" + opts.userDataDir, "--headless"],
    executablePath: ELECTRON_BIN,
    env: launchEnv,
    timeout: opts.timeoutMs ?? 30000,
  });

  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  const h = await healthOk(port, token, deadline);
  if (!h.ok) {
    await app.close().catch(() => undefined);
    throw new Error("headless /health did not come up on port " + port + "; last=" + JSON.stringify(h.body));
  }
  return {
    app,
    port,
    token,
    userDataDir: opts.userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
      await killOrphanChromium(opts.userDataDir).catch(() => undefined);
    },
  };
}

export async function dismissWizard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).wizardDismissed = true;
    try {
      localStorage.setItem("agent-browser-studio-wizard-dismissed", "1");
    } catch (_) {
      /* ignore */
    }
  });
  await closeAllDialogs(page);
  await page.waitForTimeout(300);
  // The wizard may have opened after our flag; close it again
  await closeAllDialogs(page);
}

export async function getAgentBrowserApi<T = any>(page: Page): Promise<T> {
  return page.evaluate(() => (window as any).agentBrowser.api) as Promise<T>;
}

export async function waitForAgentBrowserReady(page: Page, timeoutMs = 20000): Promise<void> {
  await page.waitForFunction(
    () => (window as any).agentBrowser && (window as any).agentBrowser.switchTab,
    { timeout: timeoutMs },
  );
}

export async function stopAllProfiles(page: Page, timeoutMs = 15000): Promise<void> {
  // First pass: issue stop for every running profile
  await page.evaluate(async (tmo: number) => {
    const api = (window as any).agentBrowser.api;
    if (!api) return;
    const start = Date.now();
    while (Date.now() - start < tmo) {
      const list = await api.browser.list();
      const running = (list || []).filter((p: any) => p && p.running);
      if (running.length === 0) return;
      for (const p of running) {
        try { await api.browser.stop(p.dirId); } catch (_) { /* ignore */ }
      }
      // Give the SIGTERM + SIGKILL fallback time to actually terminate
      await new Promise((r) => setTimeout(r, 800));
    }
  }, timeoutMs);
}

export async function closeApp(handle: TestAppHandle): Promise<void> {
  // NOTE: we deliberately do NOT use the IPC-based stopAllProfiles here. When a
  // profile was launched, ipcRenderer.invoke("browser:list"/"browser:stop") can
  // hang on a wedged main process, and a single hung await blocks the whole
  // teardown past the hook timeout. Each test runs in an isolated userData
  // dir, so SIGKILL by userDataDir is sufficient and never blocks.
  // 1. Force-kill the Electron app + any managed Chromium child it spawned.
  //    pkill -f <userDataDir> matches both the main Electron process (its args
  //    carry --user-data-dir) and the Chromium children.
  await killOrphanChromium(handle.userDataDir).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));
  // 2. Best-effort, time-boxed Playwright close on the now-dead app.
  try {
    await Promise.race([
      handle.app.close(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch (_) {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 300));
  // 3. Final sweep in case anything respawned or survived.
  await killOrphanChromium(handle.userDataDir).catch(() => undefined);
}

async function killOrphanChromium(userDataDir: string): Promise<void> {
  const sig = os.platform() === "win32" ? "-F" : "-9";
  const patterns = [userDataDir];
  for (const pat of patterns) {
    try {
      await execFileP("pkill", ["-9", "-f", pat]);
    } catch (_) {
      /* exit 1 = no matches, fine */
    }
  }
}

/**
 * Configure the app's default proxy via IPC, exercising the real product path
 * (user adds a proxy in the Proxies tab + sets it default). Used by J3 to make
 * extension downloads route through a test proxy when the host can't reach
 * clients2.google.com directly.
 *
 * Accepts a URL like "http://127.0.0.1:7890" or "socks5://host:1080".
 */
export async function configureDefaultProxy(
  page: Page,
  proxyUrl: string,
  name = "e2e-test-proxy",
): Promise<void> {
  const config = parseProxyUrl(proxyUrl);
  if (!config) throw new Error(`invalid proxy url: ${proxyUrl}`);
  await page.evaluate(
    async (args: { name: string; config: any }) => {
      const api = (window as any).agentBrowser.api;
      await api.proxy.add(args.name, args.config);
      await api.proxy.setDefault(args.name);
    },
    { name, config },
  );
}

function parseProxyUrl(raw: string): { type: "http" | "socks5" | "socks5h"; host: string; port: number } | null {
  const m = /^([a-z0-9]+):\/\/([^:/]+)(?::(\d+))?\/?$/i.exec(raw.trim());
  if (!m) return null;
  const [, scheme, host, port] = m;
  const type: "http" | "socks5" | "socks5h" =
    scheme.toLowerCase() === "socks5h" ? "socks5h" :
    scheme.toLowerCase() === "socks5" ? "socks5" : "http";
  const numPort = port ? Number(port) : type === "http" ? 8080 : 1080;
  return { type, host, port: numPort };
}

export function userDataProfilesDir(userDataDir: string): string {
  return path.join(userDataDir, "profiles");
}

export function userDataExtensionRepoDir(userDataDir: string): string {
  return path.join(userDataDir, "extension-repository");
}

export function userDataConfigPath(userDataDir: string): string {
  return path.join(userDataDir, "config.json");
}
