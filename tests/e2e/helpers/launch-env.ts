// Child process environment for every test Electron launch. An isolated
// --user-data-dir alone is not enough: the app also looks under os.homedir()
// for local LLM settings and managed-browser caches.
import * as fs from "node:fs";
import * as path from "node:path";

const HOST_PASS_THROUGH = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "DISPLAY", "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
] as const;
const ISOLATED_PATH_KEYS = new Set([
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP",
]);
const CHROMIUM_SELECTION_KEYS = [
  "AGENT_BROWSER_CHROMIUM_BINARY_PATH", "CLOAKLITE_CHROMIUM_BINARY_PATH",
  "AGENT_BROWSER_CHROMIUM_CACHE_DIR", "CLOAKLITE_CHROMIUM_CACHE_DIR",
] as const;
const PROVIDER_ENDPOINTS = [
  "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "AZURE_OPENAI_ENDPOINT",
  "OLLAMA_HOST",
] as const;

function requireLocalFixtureEndpoint(raw: string, name: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Test fixture ${name} must be a local HTTP endpoint`);
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password) {
    throw new Error(`Test fixture ${name} must be a local HTTP endpoint`);
  }
}

// Windows environment keys are case-insensitive even when the input is a plain
// object. Normalize before validation and copy so aliases cannot bypass guards
// or compete with an uppercase key when the child process starts.
export function normalizeTestLaunchFixtureEnv(fixture: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(fixture)) {
    if (value === undefined) continue;
    const canonical = key.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(normalized, canonical)) {
      throw new Error(`Test fixture has duplicate environment key ${canonical}`);
    }
    normalized[canonical] = value;
  }
  return normalized;
}

// Browser discovery may use these four runner inputs, but they are not a child
// environment. Any defined caller browser selection wins as a group: a caller
// cache must not compete with a runner binary (including the legacy aliases).
export function selectTestChromiumFixtureEnv(
  fixtureEnv: NodeJS.ProcessEnv = {},
  runnerEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const fixture = normalizeTestLaunchFixtureEnv(fixtureEnv);
  const source = CHROMIUM_SELECTION_KEYS.some((key) => fixture[key] !== undefined) ? fixture : runnerEnv;
  return normalizeTestLaunchFixtureEnv(Object.fromEntries(
    Object.entries(source).filter(([key]) => CHROMIUM_SELECTION_KEYS.some((allowed) => allowed === key.toUpperCase())),
  ));
}

function validateFixtureEnv(fixture: NodeJS.ProcessEnv): void {
  for (const key of ISOLATED_PATH_KEYS) {
    if (fixture[key] !== undefined) throw new Error(`Test fixture cannot override isolated ${key}`);
  }
  if (fixture.AGENT_BROWSER_DISABLE_LEGACY_MIGRATION !== undefined
      && fixture.AGENT_BROWSER_DISABLE_LEGACY_MIGRATION !== "1") {
    throw new Error("Test fixture cannot enable legacy user-data migration");
  }
  for (const key of PROVIDER_ENDPOINTS) {
    if (fixture[key]) requireLocalFixtureEndpoint(fixture[key], key);
  }
  if (fixture.OPENAI_API_KEY && !fixture.OPENAI_BASE_URL) {
    throw new Error("Test OPENAI_API_KEY requires an explicit local OPENAI_BASE_URL fixture");
  }
  // local-agent auto-detection uses this key but ignores ANTHROPIC_BASE_URL,
  // so even a loopback fixture could send a later chat to the public API.
  if (fixture.ANTHROPIC_API_KEY) {
    throw new Error("Test fixture ANTHROPIC_API_KEY is unsupported: local-agent ignores ANTHROPIC_BASE_URL");
  }
  if (fixture.ANTHROPIC_AUTH_TOKEN && !fixture.ANTHROPIC_BASE_URL) {
    throw new Error("Test Anthropic credentials require an explicit local ANTHROPIC_BASE_URL fixture");
  }
  if (fixture.AZURE_OPENAI_API_KEY && !fixture.AZURE_OPENAI_ENDPOINT) {
    throw new Error("Test Azure credentials require an explicit local AZURE_OPENAI_ENDPOINT fixture");
  }
  for (const [key, value] of Object.entries(fixture)) {
    if (value && /^(GOOGLE|GEMINI|MISTRAL|COHERE|GROQ|DEEPSEEK|TOGETHER)_(API_KEY|AUTH_TOKEN)$/.test(key)) {
      throw new Error(`Test fixture ${key} has no supported local endpoint mapping`);
    }
  }
}

// Version-pin journeys need the installed builds, not a single forced binary.
// Expose only recognized browser installation directories inside the test cache;
// the child never receives the host HOME/cache root or its provider settings.
export function stageVersionedChromiumInstallations(
  userDataDir: string,
  sourceRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const cache = path.join(path.resolve(userDataDir), "chromium-cache");
  fs.mkdirSync(cache, { recursive: true });
  const binaryParts = platform === "darwin"
    ? ["Chromium.app", "Contents", "MacOS", "Chromium"]
    : [platform === "win32" ? "chrome.exe" : "chromium"];
  const staged: string[] = [];
  for (const sourceRoot of sourceRoots) {
    if (!fs.existsSync(sourceRoot)) continue;
    for (const entry of fs.readdirSync(sourceRoot)) {
      if (!/^chromium-\d+(?:\.\d+){3}$/.test(entry)) continue;
      const installDir = path.join(sourceRoot, entry);
      const target = path.join(cache, entry);
      if (fs.existsSync(target)) continue; // current cache wins over retained builds
      const binary = path.join(installDir, ...binaryParts);
      if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) continue;
      // An isolated version directory links to the existing executable bundle.
      // Chromium writes its profile into --user-data-dir, never this install.
      fs.symlinkSync(installDir, target, platform === "win32" ? "junction" : "dir");
      staged.push(target);
    }
  }
  return staged;
}

export function buildIsolatedTestLaunchEnv(opts: {
  userDataDir: string;
  fixtureEnv?: NodeJS.ProcessEnv;
  hostEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const root = path.resolve(opts.userDataDir);
  const home = path.join(root, "test-home");
  const fixture = normalizeTestLaunchFixtureEnv(opts.fixtureEnv);
  validateFixtureEnv(fixture);

  const env: NodeJS.ProcessEnv = {};
  for (const key of HOST_PASS_THROUGH) {
    const value = (opts.hostEnv ?? process.env)[key];
    if (value !== undefined) env[key] = value;
  }
  const isolated: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: path.join(root, "test-tmp"),
    TMP: path.join(root, "test-tmp"),
    TEMP: path.join(root, "test-tmp"),
  };
  for (const dir of new Set(Object.values(isolated))) fs.mkdirSync(dir!, { recursive: true });

  Object.assign(env, isolated, {
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    AGENT_BROWSER_DISABLE_LEGACY_MIGRATION: "1",
    AGENT_BROWSER_BUNDLED_RESOURCES: path.join(root, "bundled-resources"),
    AGENT_BROWSER_BUNDLED_CACHE_DIR: path.join(root, "bundled-cache"),
    AGENT_BROWSER_CHROMIUM_CACHE_DIR: path.join(root, "chromium-cache"),
    AGENT_BROWSER_FIREFOX_CACHE_DIR: path.join(root, "firefox-cache"),
    AGENT_BROWSER_API_PORT: "0",
    AGENT_BROWSER_MCP_PORT: "0",
  });
  // A test can opt into a known local mock endpoint or an explicit browser
  // fixture path. Nothing from the parent provider environment is copied.
  Object.assign(env, fixture);
  if (fixture.CLOAK_API_PORT !== undefined && fixture.AGENT_BROWSER_API_PORT === undefined) {
    delete env.AGENT_BROWSER_API_PORT;
  }
  if (fixture.CLOAK_MCP_PORT !== undefined && fixture.AGENT_BROWSER_MCP_PORT === undefined) {
    delete env.AGENT_BROWSER_MCP_PORT;
  }
  if (fixture.CLOAKLITE_CHROMIUM_CACHE_DIR !== undefined && fixture.AGENT_BROWSER_CHROMIUM_CACHE_DIR === undefined) {
    delete env.AGENT_BROWSER_CHROMIUM_CACHE_DIR;
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
