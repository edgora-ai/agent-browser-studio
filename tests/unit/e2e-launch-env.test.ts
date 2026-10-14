import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron } from "playwright";
import { launchHeadlessApp, setupTestApp, type SetupTestAppOptions } from "../e2e/helpers/app.js";
import { buildIsolatedTestLaunchEnv, normalizeTestLaunchFixtureEnv, selectTestChromiumFixtureEnv, stageVersionedChromiumInstallations } from "../e2e/helpers/launch-env.js";

vi.mock("playwright", () => ({ _electron: { launch: vi.fn() } }));
vi.mock("../e2e/helpers/diag.js", () => ({ closeAllDialogs: vi.fn() }));

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "abs-launch-env-test-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function build(hostEnv: NodeJS.ProcessEnv, fixtureEnv?: NodeJS.ProcessEnv) {
  return buildIsolatedTestLaunchEnv({ userDataDir: root, hostEnv, fixtureEnv });
}

describe("isolated E2E Electron launch environment", () => {
  it("does not copy host HOME, provider keys, endpoints, models, tokens or cache/port overrides", () => {
    const host: NodeJS.ProcessEnv = {
      PATH: "/test/bin", LANG: "en_US.UTF-8", HOME: "/fake-host-home",
      USERPROFILE: "C:\\fake-host", APPDATA: "C:\\fake-host\\appdata",
      OPENAI_API_KEY: "fake-host-openai", OPENAI_BASE_URL: "https://host.invalid/v1",
      OPENAI_MODEL: "host-model", ANTHROPIC_API_KEY: "fake-host-anthropic",
      ANTHROPIC_AUTH_TOKEN: "fake-host-token", ANTHROPIC_BASE_URL: "https://host.invalid",
      ANTHROPIC_MODEL: "host-model", AGENT_BROWSER_API_TOKEN: "host-rest-token",
      AGENT_BROWSER_MCP_TOKEN: "host-mcp-token", AGENT_BROWSER_API_PORT: "15001",
      AGENT_BROWSER_MCP_PORT: "15002", AGENT_BROWSER_CHROMIUM_BINARY_PATH: "/host/chromium",
      AGENT_BROWSER_CHROMIUM_CACHE_DIR: "/host/chromium-cache",
      AGENT_BROWSER_BUNDLED_RESOURCES: "/host/bundled",
      AGENT_BROWSER_LICENSE_PUBKEY: "host-pubkey", AGENT_BROWSER_UPDATE_MANIFEST: "https://host.invalid/manifest",
      NODE_OPTIONS: "--require=/fake-host-home/inject.js", ELECTRON_RUN_AS_NODE: "1",
    };
    const env = build(host);
    expect(env.PATH).toBe(host.PATH);
    expect(env.LANG).toBe(host.LANG);
    for (const key of [
      "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
      "AGENT_BROWSER_API_TOKEN", "AGENT_BROWSER_MCP_TOKEN", "AGENT_BROWSER_CHROMIUM_BINARY_PATH",
      "AGENT_BROWSER_LICENSE_PUBKEY", "AGENT_BROWSER_UPDATE_MANIFEST",
      "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
    ]) expect(env[key], key).toBeUndefined();
    expect(env.HOME).toBe(path.join(root, "test-home"));
    expect(env.USERPROFILE).toBe(env.HOME);
    for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP"]) {
      expect(env[key]?.startsWith(root), key).toBe(true);
      expect(fs.statSync(env[key]!).isDirectory(), key).toBe(true);
    }
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(root, "chromium-cache"));
    expect(env.AGENT_BROWSER_FIREFOX_CACHE_DIR).toBe(path.join(root, "firefox-cache"));
    expect(env.AGENT_BROWSER_BUNDLED_CACHE_DIR).toBe(path.join(root, "bundled-cache"));
    expect(env.AGENT_BROWSER_BUNDLED_RESOURCES).toBe(path.join(root, "bundled-resources"));
    expect(env.AGENT_BROWSER_DISABLE_LEGACY_MIGRATION).toBe("1");
    expect(env.AGENT_BROWSER_API_PORT).toBe("0");
    expect(env.AGENT_BROWSER_MCP_PORT).toBe("0");
  });

  it("omits undefined fixture values from the string-only child environment", () => {
    const env = build({ PATH: "/test/bin" }, { OPENAI_MODEL: undefined });
    expect(env).not.toHaveProperty("OPENAI_MODEL");
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  });

  it("does not let undefined protected fixtures erase isolated defaults or trigger alias fallback", () => {
    const fixture: NodeJS.ProcessEnv = {
      HOME: undefined, userprofile: undefined, AppData: undefined, LOCALAPPDATA: undefined,
      xdg_config_home: undefined, XDG_CACHE_HOME: undefined, XDG_DATA_HOME: undefined,
      xdg_state_home: undefined, tmpdir: undefined, TMP: undefined, Temp: undefined,
      agent_browser_disable_legacy_migration: undefined,
      AGENT_BROWSER_API_PORT: undefined, cloak_api_port: undefined,
      agent_browser_mcp_port: undefined, CLOAK_MCP_PORT: undefined,
      agent_browser_chromium_cache_dir: undefined, CloakLite_Chromium_Cache_Dir: undefined,
      AGENT_BROWSER_FIREFOX_CACHE_DIR: undefined, agent_browser_bundled_cache_dir: undefined,
      Agent_Browser_Bundled_Resources: undefined,
    };
    expect(normalizeTestLaunchFixtureEnv(fixture)).toEqual({});
    const defaults = build({}, {});
    const env = build({}, fixture);
    for (const key of [
      "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP",
      "AGENT_BROWSER_DISABLE_LEGACY_MIGRATION", "AGENT_BROWSER_API_PORT", "AGENT_BROWSER_MCP_PORT",
      "AGENT_BROWSER_CHROMIUM_CACHE_DIR", "AGENT_BROWSER_FIREFOX_CACHE_DIR",
      "AGENT_BROWSER_BUNDLED_CACHE_DIR", "AGENT_BROWSER_BUNDLED_RESOURCES",
    ]) {
      expect(env[key], key).toBe(defaults[key]);
      expect(typeof env[key], key).toBe("string");
    }
    expect(env.HOME).toBe(path.join(root, "test-home"));
    expect(env.AGENT_BROWSER_DISABLE_LEGACY_MIGRATION).toBe("1");
    expect(env.AGENT_BROWSER_API_PORT).toBe("0");
    expect(env.AGENT_BROWSER_MCP_PORT).toBe("0");
    for (const key of ["CLOAK_API_PORT", "CLOAK_MCP_PORT", "CLOAKLITE_CHROMIUM_CACHE_DIR"]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("ignores undefined aliases while rejecting actual duplicate aliases and protected overrides", () => {
    expect(normalizeTestLaunchFixtureEnv({ openai_model: undefined, OPENAI_MODEL: "mock" }))
      .toEqual({ OPENAI_MODEL: "mock" });
    expect(() => build({}, { OPENAI_MODEL: "one", openai_model: "two" }))
      .toThrow(/duplicate.*OPENAI_MODEL/i);
    expect(() => build({}, { home: undefined, HOME: "/host" })).toThrow(/isolated HOME/);
    expect(() => build({}, { anthropic_api_key: undefined, ANTHROPIC_API_KEY: "mock" }))
      .toThrow(/ANTHROPIC_API_KEY.*ignores ANTHROPIC_BASE_URL/);
  });

  it("keeps Windows executable discovery without inheriting Windows profile paths", () => {
    const env = build({ Path: "C:\\test-bin", PATHEXT: ".EXE;.CMD", USERPROFILE: "C:\\real-profile" });
    expect(env.Path).toBe("C:\\test-bin");
    expect(env.PATHEXT).toBe(".EXE;.CMD");
    expect(env.USERPROFILE).toBe(path.join(root, "test-home"));
  });

  it("honors explicit local mock and browser fixture overrides, never host credentials", () => {
    const browserFixture = path.join(root, "fixture-browsers");
    const env = build({ OPENAI_API_KEY: "fake-host-only", AGENT_BROWSER_CHROMIUM_CACHE_DIR: "/host/cache" }, {
      OPENAI_API_KEY: "fake-local-only",
      OPENAI_BASE_URL: "http://127.0.0.1:43911/v1",
      OPENAI_MODEL: "fixture-model",
      AGENT_BROWSER_CHROMIUM_CACHE_DIR: browserFixture,
      AGENT_BROWSER_API_PORT: "0",
    });
    expect(env.OPENAI_API_KEY).toBe("fake-local-only");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:43911/v1");
    expect(env.OPENAI_MODEL).toBe("fixture-model");
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(browserFixture);
    expect(env.AGENT_BROWSER_API_PORT).toBe("0");
    expect(env.HOME).toBe(path.join(root, "test-home"));
  });

  it("rejects Anthropic API keys even with a loopback URL because auto-detection ignores it", () => {
    expect(() => build({}, {
      ANTHROPIC_API_KEY: "fake-local-only",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:43911/v1",
    })).toThrow(/ANTHROPIC_API_KEY.*ignores ANTHROPIC_BASE_URL/);
    // On Windows environment names are case-insensitive, even for a plain fixture object.
    expect(() => build({}, { anthropic_api_key: "fake-local-only" }))
      .toThrow(/ANTHROPIC_API_KEY.*ignores ANTHROPIC_BASE_URL/);
    expect(() => build({}, { Anthropic_Api_Key: "fake-local-only" }))
      .toThrow(/ANTHROPIC_API_KEY.*ignores ANTHROPIC_BASE_URL/);
  });

  it("validates case-insensitive provider endpoints and isolation keys without copying aliases", () => {
    expect(() => build({}, { openai_api_key: "fake", openai_base_url: "https://example.invalid/v1" }))
      .toThrow(/local HTTP endpoint/);
    expect(() => build({}, { home: "/host" })).toThrow(/isolated HOME/);
    expect(() => build({}, { OPENAI_API_KEY: "first", openai_api_key: "second", OPENAI_BASE_URL: "http://127.0.0.1:43911/v1" }))
      .toThrow(/duplicate.*OPENAI_API_KEY/i);
    const env = build({}, { openai_api_key: "fake", openai_base_url: "http://127.0.0.1:43911/v1" });
    expect(env.OPENAI_API_KEY).toBe("fake");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:43911/v1");
    expect(env.openai_api_key).toBeUndefined();
  });

  it("stages only installed browser builds for version pins under the isolated cache", () => {
    const currentRoot = path.join(root, "current-browser-installs");
    const retainedRoot = path.join(root, "retained-browser-installs");
    const userDataDir = path.join(root, "isolated-app");
    const binaryParts = process.platform === "darwin"
      ? ["Chromium.app", "Contents", "MacOS", "Chromium"]
      : [process.platform === "win32" ? "chrome.exe" : "chromium"];
    const install = (cacheRoot: string, version: string) => {
      const dir = path.join(cacheRoot, `chromium-${version}`);
      const bin = path.join(dir, ...binaryParts);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, "fixture-browser-binary");
      return dir;
    };
    const current = install(currentRoot, "102.0.0.0");
    const retained = install(retainedRoot, "101.0.0.0");
    install(retainedRoot, "102.0.0.0"); // current root takes precedence
    fs.mkdirSync(path.join(currentRoot, "chromium-99.0.0.0")); // incomplete install
    fs.writeFileSync(path.join(currentRoot, "settings.json"), "not-a-browser");

    const staged = stageVersionedChromiumInstallations(userDataDir, [currentRoot, retainedRoot]);
    const cache = path.join(userDataDir, "chromium-cache");
    expect(staged).toHaveLength(2);
    expect(fs.readdirSync(cache).sort()).toEqual(["chromium-101.0.0.0", "chromium-102.0.0.0"]);
    expect(fs.realpathSync(path.join(cache, "chromium-102.0.0.0"))).toBe(fs.realpathSync(current));
    expect(fs.realpathSync(path.join(cache, "chromium-101.0.0.0"))).toBe(fs.realpathSync(retained));
    expect(fs.statSync(path.join(cache, "chromium-101.0.0.0", ...binaryParts)).isFile()).toBe(true);
    expect(fs.existsSync(path.join(cache, "settings.json"))).toBe(false);
    const env = buildIsolatedTestLaunchEnv({ userDataDir, hostEnv: { HOME: "/host", ANTHROPIC_API_KEY: "host-secret" } });
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(cache);
    expect(env.HOME).toBe(path.join(userDataDir, "test-home"));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(stageVersionedChromiumInstallations(userDataDir, [currentRoot, retainedRoot])).toEqual([]);
  });

  it("rejects cloud endpoints, credentials without local endpoint and isolation overrides", () => {
    expect(() => build({}, { OPENAI_API_KEY: "fake", OPENAI_BASE_URL: "https://example.invalid/v1" }))
      .toThrow(/local HTTP endpoint/);
    expect(() => build({}, { ANTHROPIC_AUTH_TOKEN: "fake" })).toThrow(/local ANTHROPIC_BASE_URL/);
    expect(() => build({}, { HOME: "/host" })).toThrow(/isolated HOME/);
    expect(() => build({}, { AGENT_BROWSER_DISABLE_LEGACY_MIGRATION: "0" })).toThrow(/legacy user-data migration/);
  });
});

const CHROMIUM_KEYS = [
  "AGENT_BROWSER_CHROMIUM_BINARY_PATH", "CLOAKLITE_CHROMIUM_BINARY_PATH",
  "AGENT_BROWSER_CHROMIUM_CACHE_DIR", "CLOAKLITE_CHROMIUM_CACHE_DIR",
] as const;

describe("Chromium discovery inputs", () => {
  it("reads only the four browser selection keys from the runner", () => {
    const runner = {
      AGENT_BROWSER_CHROMIUM_BINARY_PATH: "/runner/current-binary",
      CLOAKLITE_CHROMIUM_BINARY_PATH: "/runner/legacy-binary",
      AGENT_BROWSER_CHROMIUM_CACHE_DIR: "/runner/current-cache",
      CLOAKLITE_CHROMIUM_CACHE_DIR: "/runner/legacy-cache",
      HOME: "/runner/home", OPENAI_API_KEY: "runner-secret", AGENT_BROWSER_API_TOKEN: "runner-secret",
      AGENT_BROWSER_FIREFOX_CACHE_DIR: "/runner/firefox", NODE_OPTIONS: "--require=/runner/inject.js",
      OPENAI_MODEL: "one", openai_model: "two", // irrelevant runner aliases are not validated/copied
    };
    const selected = selectTestChromiumFixtureEnv({}, runner);
    expect(selected).toEqual(Object.fromEntries(CHROMIUM_KEYS.map((key) => [key, runner[key]])));
    expect(Object.keys(selected)).toEqual([...CHROMIUM_KEYS]);
  });

  it.each(CHROMIUM_KEYS)("treats a caller %s selection as the complete group, including empty values", (key) => {
    const runner = Object.fromEntries(CHROMIUM_KEYS.map((k) => [k, `/runner/${k}`]));
    const fixture = { [key]: "", OPENAI_MODEL: "fixture-only", HOME: undefined };
    expect(selectTestChromiumFixtureEnv(fixture, runner)).toEqual({ [key]: "" });
    expect(fixture).toEqual({ [key]: "", OPENAI_MODEL: "fixture-only", HOME: undefined });
    expect(runner).toEqual(Object.fromEntries(CHROMIUM_KEYS.map((k) => [k, `/runner/${k}`])));
  });

  it("ignores undefined fixture keys without erasing defined runner aliases", () => {
    const fixture = Object.fromEntries(CHROMIUM_KEYS.map((key) => [key, undefined]));
    const runner = { AGENT_BROWSER_CHROMIUM_BINARY_PATH: undefined, agent_browser_chromium_binary_path: "/runner/binary" };
    expect(selectTestChromiumFixtureEnv(fixture, runner)).toEqual({ AGENT_BROWSER_CHROMIUM_BINARY_PATH: "/runner/binary" });
    expect(selectTestChromiumFixtureEnv({ CLOAKLITE_CHROMIUM_CACHE_DIR: "/caller/cache", AGENT_BROWSER_CHROMIUM_BINARY_PATH: undefined }, runner))
      .toEqual({ CLOAKLITE_CHROMIUM_CACHE_DIR: "/caller/cache" });
  });

  it("normalizes case-insensitive selections before deciding whose group wins", () => {
    const runner = { agent_browser_chromium_binary_path: "/runner/binary", CloakLite_Chromium_Cache_Dir: "/runner/cache" };
    expect(selectTestChromiumFixtureEnv({}, runner))
      .toEqual({ AGENT_BROWSER_CHROMIUM_BINARY_PATH: "/runner/binary", CLOAKLITE_CHROMIUM_CACHE_DIR: "/runner/cache" });
    expect(selectTestChromiumFixtureEnv({ cloaklite_chromium_cache_dir: "/caller/cache" }, runner))
      .toEqual({ CLOAKLITE_CHROMIUM_CACHE_DIR: "/caller/cache" });
  });

  it("rejects competing case aliases in the selected group, not an unused runner group", () => {
    const duplicates = { AGENT_BROWSER_CHROMIUM_BINARY_PATH: "/one", agent_browser_chromium_binary_path: "/two" };
    expect(() => selectTestChromiumFixtureEnv({}, duplicates)).toThrow(/duplicate.*AGENT_BROWSER_CHROMIUM_BINARY_PATH/);
    expect(() => selectTestChromiumFixtureEnv(duplicates, {})).toThrow(/duplicate.*AGENT_BROWSER_CHROMIUM_BINARY_PATH/);
    expect(selectTestChromiumFixtureEnv({ CLOAKLITE_CHROMIUM_CACHE_DIR: "/caller/cache" }, duplicates))
      .toEqual({ CLOAKLITE_CHROMIUM_CACHE_DIR: "/caller/cache" });
  });
});

const binaryParts = process.platform === "darwin"
  ? ["Chromium.app", "Contents", "MacOS", "Chromium"]
  : [process.platform === "win32" ? "chrome.exe" : "chromium"];

function installChromium(cache: string, version: string): string {
  const binary = path.join(cache, `chromium-${version}`, ...binaryParts);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `fixture-browser-${version}`);
  return binary;
}

// Exercise the real setupTestApp wiring used by J1, without launching Electron.
// Mock only Playwright's process/UI boundary; resolution and child-env isolation
// use real directories and files owned by this test.
describe("setupTestApp Chromium selection", () => {
  let home: string;
  let runnerCache: string;
  let runnerBinary: string;
  let callerCache: string;
  let callerBinary: string;
  let userDataDir: string;

  beforeEach(() => {
    home = path.join(root, "empty-runner-home");
    fs.mkdirSync(home);
    for (const key of CHROMIUM_KEYS) vi.stubEnv(key, undefined);
    vi.stubEnv("AGENT_BROWSER_E2E_TRACE", undefined);
    vi.stubEnv("CLOAK_E2E_TRACE", undefined);
    vi.stubEnv("AGENT_BROWSER_E2E_UNSANDBOXED", undefined);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(os.homedir()).toBe(home);
    vi.stubEnv("OPENAI_API_KEY", "runner-secret");
    vi.stubEnv("OPENAI_BASE_URL", "https://runner.invalid/v1");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "runner-secret");
    vi.stubEnv("AGENT_BROWSER_API_TOKEN", "runner-rest-secret");
    vi.stubEnv("AGENT_BROWSER_MCP_TOKEN", "runner-mcp-secret");
    vi.stubEnv("AGENT_BROWSER_API_PORT", "15001");
    vi.stubEnv("AGENT_BROWSER_FIREFOX_CACHE_DIR", "/runner/firefox-cache");
    vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", "/runner/bundled-resources");
    vi.stubEnv("NODE_OPTIONS", "--require=/runner/inject.js");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    runnerCache = path.join(root, "runner-cache");
    runnerBinary = installChromium(runnerCache, "103.0.0.0");
    callerCache = path.join(root, "caller-cache");
    callerBinary = installChromium(callerCache, "101.0.0.0");
    userDataDir = path.join(root, "app");
    const page = {
      url: () => "file:///fixture/index.html",
      on: vi.fn(), evaluate: vi.fn(), waitForFunction: vi.fn(),
      waitForSelector: vi.fn(), waitForTimeout: vi.fn(),
    };
    vi.mocked(electron.launch).mockReset();
    vi.mocked(electron.launch).mockResolvedValue({ windows: () => [page] } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function launch(opts: Partial<SetupTestAppOptions> = {}) {
    await setupTestApp({ userDataDir, ...opts });
    expect(electron.launch).toHaveBeenCalledTimes(1);
    return vi.mocked(electron.launch).mock.calls[0][0]!.env!;
  }

  function expectIsolated(env: NodeJS.ProcessEnv) {
    expect(env.HOME).toBe(path.join(userDataDir, "test-home"));
    expect(env.USERPROFILE).toBe(env.HOME);
    for (const key of [
      "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
      "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP",
    ]) {
      expect(env[key]?.startsWith(userDataDir), key).toBe(true);
      expect(fs.statSync(env[key]!).isDirectory(), key).toBe(true);
    }
    for (const key of [
      "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "AGENT_BROWSER_API_TOKEN",
      "AGENT_BROWSER_MCP_TOKEN", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
    ]) expect(env[key], key).toBeUndefined();
    expect(env.AGENT_BROWSER_API_PORT).toBe("0");
    expect(env.AGENT_BROWSER_FIREFOX_CACHE_DIR).toBe(path.join(userDataDir, "firefox-cache"));
    expect(env.AGENT_BROWSER_BUNDLED_RESOURCES).toBe(path.join(userDataDir, "bundled-resources"));
    expect(env.AGENT_BROWSER_DISABLE_LEGACY_MIGRATION).toBe("1");
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  }

  it.each(CHROMIUM_KEYS)("uses runner %s with an empty HOME and no opts.env (J1 default)", async (key) => {
    vi.stubEnv(key, key.endsWith("BINARY_PATH") ? runnerBinary : runnerCache);
    const env = await launch();
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(runnerBinary);
    expect(fs.readFileSync(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH!, "utf8")).toBe("fixture-browser-103.0.0.0");
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
    expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBeUndefined();
    expect(env.CLOAKLITE_CHROMIUM_BINARY_PATH).toBeUndefined();
    expectIsolated(env);
  });

  it("resolves the newest installed version from a runner cache, without exposing that cache", async () => {
    installChromium(runnerCache, "99.0.0.0");
    const newest = installChromium(runnerCache, "104.0.0.0");
    fs.mkdirSync(path.join(runnerCache, "chromium-999.0.0.0")); // incomplete build is not usable
    vi.stubEnv("CLOAKLITE_CHROMIUM_CACHE_DIR", runnerCache);
    const env = await launch();
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(newest);
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
    expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBeUndefined();
    expectIsolated(env);
  });

  it("retains binary-over-cache and canonical-over-legacy precedence within the runner group", async () => {
    const legacyBinary = installChromium(path.join(root, "legacy-runner-cache"), "104.0.0.0");
    vi.stubEnv("AGENT_BROWSER_CHROMIUM_BINARY_PATH", runnerBinary);
    vi.stubEnv("CLOAKLITE_CHROMIUM_BINARY_PATH", legacyBinary);
    vi.stubEnv("AGENT_BROWSER_CHROMIUM_CACHE_DIR", callerCache);
    vi.stubEnv("CLOAKLITE_CHROMIUM_CACHE_DIR", callerCache);
    const env = await launch();
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(runnerBinary);
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
    expect(env.CLOAKLITE_CHROMIUM_BINARY_PATH).toBeUndefined();
    expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBeUndefined();
    expectIsolated(env);
  });

  it("wires normalized caller aliases without letting a runner binary override a caller cache", async () => {
    vi.stubEnv("AGENT_BROWSER_CHROMIUM_BINARY_PATH", runnerBinary);
    const env = await launch({ env: { cloaklite_chromium_cache_dir: callerCache, AGENT_BROWSER_CHROMIUM_BINARY_PATH: undefined } });
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(callerBinary);
    expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBe(callerCache);
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBeUndefined();
    expectIsolated(env);
  });

  it.each(["AGENT_BROWSER_CHROMIUM_BINARY_PATH", "CLOAKLITE_CHROMIUM_CACHE_DIR"])(
    "also resolves headless runner %s without passing runner credentials or cache", async (key) => {
      vi.stubEnv(key, key.endsWith("BINARY_PATH") ? runnerBinary : runnerCache);
      let authorization: string | undefined;
      const server = http.createServer((req, res) => {
        authorization = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Headless fixture port was not allocated");
      try {
        const handle = await launchHeadlessApp({ userDataDir, env: { AGENT_BROWSER_API_PORT: String(address.port) } });
        const env = vi.mocked(electron.launch).mock.calls[0][0]!.env!;
        expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(runnerBinary);
        expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
        expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBeUndefined();
        expect(env.HOME).toBe(path.join(userDataDir, "test-home"));
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.AGENT_BROWSER_MCP_TOKEN).toBeUndefined();
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(handle.port).toBe(address.port);
        expect(handle.token).toBe("test-headless-token");
        expect(env.AGENT_BROWSER_API_TOKEN).toBe(handle.token);
        expect(authorization).toBe(`Bearer ${handle.token}`);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  );

  it.each(CHROMIUM_KEYS.flatMap((callerKey) => CHROMIUM_KEYS.map((runnerKey) => [callerKey, runnerKey] as const)))(
    "lets caller %s win over runner %s as a group", async (callerKey, runnerKey) => {
      vi.stubEnv(runnerKey, runnerKey.endsWith("BINARY_PATH") ? runnerBinary : runnerCache);
      const callerValue = callerKey.endsWith("BINARY_PATH") ? callerBinary : callerCache;
      const env = await launch({ env: { [callerKey]: callerValue } });
      expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(callerBinary);
      expect(env[callerKey]).toBe(callerValue);
      if (callerKey.endsWith("BINARY_PATH")) {
        expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
        expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBeUndefined();
      }
      expectIsolated(env);
    },
  );

  it.each(CHROMIUM_KEYS)("does not let undefined caller browser aliases erase runner %s", async (key) => {
    vi.stubEnv(key, key.endsWith("BINARY_PATH") ? runnerBinary : runnerCache);
    const env = await launch({ env: Object.fromEntries(CHROMIUM_KEYS.map((k) => [k, undefined])) });
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(runnerBinary);
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
    expectIsolated(env);
  });

  it("does not need a browser binary when neither runner nor HOME has an installation", async () => {
    const env = await launch();
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBeUndefined();
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
    expectIsolated(env);
  });

  it("retains installed-HOME discovery when the runner has no browser override", async () => {
    const installed = installChromium(path.join(home, ".agent-browser-studio"), "102.0.0.0");
    installChromium(path.join(home, ".roxy-lite-cloak"), "101.0.0.0");
    const env = await launch();
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBe(installed);
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(path.join(userDataDir, "chromium-cache"));
    expectIsolated(env);
  });

  it("reports an invalid explicit runner binary instead of silently launching without it", async () => {
    const missing = path.join(root, "missing-chromium");
    vi.stubEnv("AGENT_BROWSER_CHROMIUM_BINARY_PATH", missing);
    await expect(setupTestApp({ userDataDir })).rejects.toThrow(`Explicit Chromium binary does not exist: ${missing}`);
    expect(electron.launch).not.toHaveBeenCalled();
  });

  it("keeps profile-version staging rather than forcing the runner binary/cache", async () => {
    vi.stubEnv("AGENT_BROWSER_CHROMIUM_BINARY_PATH", path.join(root, "missing-runner-binary"));
    vi.stubEnv("CLOAKLITE_CHROMIUM_CACHE_DIR", runnerCache);
    const currentCache = path.join(home, ".agent-browser-studio");
    const retainedCache = path.join(home, ".roxy-lite-cloak");
    const current = installChromium(currentCache, "102.0.0.0");
    const retained = installChromium(retainedCache, "101.0.0.0");
    const env = await launch({ allowProfileVersionSelection: true });
    expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBeUndefined();
    expect(env.CLOAKLITE_CHROMIUM_BINARY_PATH).toBeUndefined();
    expect(env.CLOAKLITE_CHROMIUM_CACHE_DIR).toBeUndefined();
    const cache = path.join(userDataDir, "chromium-cache");
    expect(env.AGENT_BROWSER_CHROMIUM_CACHE_DIR).toBe(cache);
    expect(fs.readdirSync(cache).sort()).toEqual(["chromium-101.0.0.0", "chromium-102.0.0.0"]);
    expect(fs.realpathSync(path.join(cache, "chromium-102.0.0.0", ...binaryParts))).toBe(current);
    expect(fs.realpathSync(path.join(cache, "chromium-101.0.0.0", ...binaryParts))).toBe(retained);
    expectIsolated(env);
  });

  it.each(CHROMIUM_KEYS)("keeps explicit %s unchanged in the profile-version branch", async (key) => {
    vi.stubEnv("AGENT_BROWSER_CHROMIUM_BINARY_PATH", runnerBinary);
    installChromium(path.join(home, ".agent-browser-studio"), "102.0.0.0");
    const value = key.endsWith("BINARY_PATH") ? callerBinary : callerCache;
    const env = await launch({ allowProfileVersionSelection: true, env: { [key]: value } });
    expect(env[key]).toBe(value);
    if (key !== "AGENT_BROWSER_CHROMIUM_BINARY_PATH") expect(env.AGENT_BROWSER_CHROMIUM_BINARY_PATH).toBeUndefined();
    expect(fs.existsSync(path.join(userDataDir, "chromium-cache", "chromium-102.0.0.0"))).toBe(false);
    expectIsolated(env);
  });
});
