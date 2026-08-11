// App helper — launch the real Electron app via Playwright with isolated userData.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { _electron as electron, ElectronApplication, Page } from "playwright";
import { closeAllDialogs } from "./diag.js";

const execFileP = promisify(execFile);

// Locate the independently built Chromium cache without consulting a wrapper
// cache or network service.
function resolveManagedChromiumPath(): string | null {
  if (process.env.CLOAKLITE_CHROMIUM_BINARY_PATH && fs.existsSync(process.env.CLOAKLITE_CHROMIUM_BINARY_PATH)) {
    return process.env.CLOAKLITE_CHROMIUM_BINARY_PATH;
  }
  const home = os.homedir();
  return newestCachedBinary(path.join(home, ".roxy-lite-cloak"));
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

  const chromiumBin = resolveManagedChromiumPath();
  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    ...opts.env,
  };
  if (chromiumBin && !opts.allowProfileVersionSelection) launchEnv.CLOAKLITE_CHROMIUM_BINARY_PATH = chromiumBin;

  const app = await electron.launch({
    args: [REPO, `--user-data-dir=${opts.userDataDir}`, ...(opts.args ?? [])],
    executablePath: ELECTRON_BIN,
    env: launchEnv,
    timeout: opts.timeoutMs ?? 30000,
  });
  if (process.env.CLOAK_E2E_TRACE === "1") {
    app.process().stdout?.on("data", (chunk) => process.stdout.write(`[electron:stdout] ${chunk}`));
    app.process().stderr?.on("data", (chunk) => process.stderr.write(`[electron:stderr] ${chunk}`));
  }

  const page = await app.firstWindow({ timeout: 20000 });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.waitForFunction(
    () => (window as any).cloak && (window as any).cloak.switchTab,
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

export async function dismissWizard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).wizardDismissed = true;
    try {
      localStorage.setItem("cloak-wizard-dismissed", "1");
    } catch (_) {
      /* ignore */
    }
  });
  await closeAllDialogs(page);
  await page.waitForTimeout(300);
  // The wizard may have opened after our flag; close it again
  await closeAllDialogs(page);
}

export async function getRoxyApi<T = any>(page: Page): Promise<T> {
  return page.evaluate(() => (window as any).cloak.api) as Promise<T>;
}

export async function waitForRoxyReady(page: Page, timeoutMs = 20000): Promise<void> {
  await page.waitForFunction(
    () => (window as any).cloak && (window as any).cloak.switchTab,
    { timeout: timeoutMs },
  );
}

export async function stopAllProfiles(page: Page, timeoutMs = 15000): Promise<void> {
  // First pass: issue stop for every running profile
  await page.evaluate(async (tmo: number) => {
    const api = (window as any).cloak.api;
    if (!api) return;
    const start = Date.now();
    while (Date.now() - start < tmo) {
      const list = await api.cloak.list();
      const running = (list || []).filter((p: any) => p && p.running);
      if (running.length === 0) return;
      for (const p of running) {
        try { await api.cloak.stop(p.dirId); } catch (_) { /* ignore */ }
      }
      // Give the SIGTERM + SIGKILL fallback time to actually terminate
      await new Promise((r) => setTimeout(r, 800));
    }
  }, timeoutMs);
}

export async function closeApp(handle: TestAppHandle): Promise<void> {
  // NOTE: we deliberately do NOT use the IPC-based stopAllProfiles here. When a
  // profile was launched, ipcRenderer.invoke("cloak:list"/"cloak:stop") can
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
      const api = (window as any).cloak.api;
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
  return path.join(userDataDir, "cloak-profiles");
}

export function userDataExtensionRepoDir(userDataDir: string): string {
  return path.join(userDataDir, "extension-repository");
}

export function userDataConfigPath(userDataDir: string): string {
  return path.join(userDataDir, "config.json");
}
